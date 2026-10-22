import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { taskReminderSentTable } from "../../apps/api/src/database/schema";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

describe("Field and bulk workflow policies", () => {
  beforeEach(resetTestDatabase);
  const headers = {
    "content-type": "application/json",
    "x-kaneo-caller": "ai",
  };
  async function fixture(completionSummary: string | null, final = true) {
    const member = await createWorkspaceMember({ role: "owner" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [column] = await db
      .insert(schema.columnTable)
      .values({
        projectId: project.id,
        name: "Released",
        slug: "released",
        position: 5,
        isFinal: true,
      })
      .returning();
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        number: 1,
        title: "Owned policy task",
        description: "Owned fixture",
        goal: "Verify policy",
        acceptanceCriteria: "Policy covers every supported path",
        status: final ? column.slug : "to-do",
        columnId: final ? column.id : null,
        completionSummary,
      })
      .returning();
    await db
      .update(schema.projectTable)
      .set({ lastTaskNumber: 1 })
      .where(eq(schema.projectTable.id, project.id));
    mockAuthenticatedSession(member.user);
    return { app: createApp().app, task, project, member };
  }

  for (const completion of [null, "Verified completion"]) {
    it.each([
      "title",
      "description",
      "priority",
      "assignee",
      "due-date",
      "bulkPriority",
      "bulkAssignee",
      "bulkDueDate",
    ])(
      `checks custom final-column evidence ${completion} through %s`,
      async (kind) => {
        const { app, task, member } = await fixture(completion);
        const body: Record<string, unknown> =
          kind === "title"
            ? { title: "Edited" }
            : kind === "description"
              ? { description: "Edited" }
              : kind === "priority"
                ? { priority: "high" }
                : kind === "assignee"
                  ? { userId: member.user.id }
                  : { dueDate: "2026-10-20T12:00:00.000Z" };
        const operation =
          kind === "bulkPriority"
            ? "updatePriority"
            : kind === "bulkAssignee"
              ? "updateAssignee"
              : "updateDueDate";
        const bulk = kind.startsWith("bulk");
        const response = await app.request(
          bulk ? "/api/task/bulk" : `/api/task/${kind}/${task.id}`,
          {
            method: bulk ? "PATCH" : "PUT",
            headers,
            body: JSON.stringify(
              bulk
                ? {
                    taskIds: [task.id],
                    operation,
                    value:
                      operation === "updatePriority"
                        ? "high"
                        : operation === "updateAssignee"
                          ? member.user.id
                          : "2026-10-20T12:00:00.000Z",
                  }
                : body,
            ),
          },
        );
        expect(response.status).toBe(completion ? 200 : 409);
        if (!completion)
          expect(await response.json()).toMatchObject({
            error: "TASK_WORKFLOW_POLICY",
            missingFields: ["completionSummary"],
          });
        const [persisted] = await db
          .select()
          .from(schema.taskTable)
          .where(eq(schema.taskTable.id, task.id));
        expect(persisted.version).toBe(task.version + (completion ? 1 : 0));
      },
    );

    it(`checks imported custom final-column evidence ${completion}`, async () => {
      const { app, project } = await fixture(completion);
      const response = await app.request(`/api/task/import/${project.id}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          tasks: [
            {
              title: "Imported policy task",
              status: "released",
              goal: "Verify import",
              acceptanceCriteria: "Completion required",
              completionSummary: completion,
            },
          ],
        }),
      });
      expect(response.status).toBe(completion ? 200 : 409);
      expect(await db.select().from(schema.taskTable)).toHaveLength(
        completion ? 2 : 1,
      );
    });
  }

  it.each(["title", "description", "status", "due-date"])(
    "rejects stale %s edit after human-required block without side effects",
    async (kind) => {
      const { app, task } = await fixture(null, false);
      await db
        .insert(taskReminderSentTable)
        .values({ taskId: task.id, reminderType: "due-soon" });
      let reachedRead!: () => void;
      let releaseRead!: () => void;
      const reached = new Promise<void>((resolve) => {
        reachedRead = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const find = db.query.taskTable.findFirst.bind(db.query.taskTable);
      vi.spyOn(db.query.taskTable, "findFirst").mockImplementationOnce((async (
        ...args: Parameters<typeof find>
      ) => {
        const snapshot = await find(...args);
        reachedRead();
        await gate;
        return snapshot;
      }) as typeof find);
      const body =
        kind === "title"
          ? { title: "Stale" }
          : kind === "description"
            ? { description: "Stale" }
            : kind === "status"
              ? { status: "in-progress" }
              : { dueDate: "2026-10-20T12:00:00.000Z" };
      const edit = app.request(`/api/task/${kind}/${task.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
      try {
        await reached;
        const block = await app.request(`/api/task/agent/${task.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            expectedVersion: task.version,
            status: "blocked",
            blockedReason: "Human review",
            unblockPolicy: "human_required",
          }),
        });
        expect(block.status).toBe(200);
      } finally {
        releaseRead();
      }
      expect((await edit).status).toBe(409);
      const [persisted] = await db
        .select()
        .from(schema.taskTable)
        .where(eq(schema.taskTable.id, task.id));
      expect(persisted).toMatchObject({
        status: "blocked",
        title: task.title,
        description: task.description,
        dueDate: task.dueDate,
        unblockPolicy: "human_required",
        version: task.version + 1,
      });
      expect(await db.select().from(taskReminderSentTable)).toHaveLength(1);
    },
    15000,
  );
});
