import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { getDatabasePool, schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

describe("Bulk and move concurrent state validation", () => {
  beforeEach(resetTestDatabase);
  const headers = {
    "content-type": "application/json",
    "x-kaneo-caller": "ai",
  };

  async function fixture() {
    const member = await createWorkspaceMember({ role: "owner" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const tasks = await db
      .insert(schema.taskTable)
      .values(
        [1, 2].map((number) => ({
          projectId: project.id,
          number,
          title: `Race task ${number}`,
          status: "to-do",
          goal: "Preserve concurrent state",
          acceptanceCriteria: "No stale mutation commits",
          completionSummary: "Initial completion evidence",
        })),
      )
      .returning();
    mockAuthenticatedSession(member.user);
    return { app: createApp().app, member, project, tasks };
  }

  async function waitForBlockedWriter(holderPid: number) {
    await vi.waitFor(
      async () => {
        const { rows } = await getDatabasePool().query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))) AS waiting",
          [holderPid],
        );
        expect(rows[0].waiting).toBe(true);
      },
      { timeout: 3000 },
    );
  }

  it.each([
    "updateStatus",
    "updatePriority",
    "updateAssignee",
    "updateDueDate",
  ])(
    "rechecks committed final state before %s and rolls back whole batch",
    async (operation) => {
      const { app, member, tasks } = await fixture();
      const producer = await getDatabasePool().connect();
      let response: Response;
      try {
        await producer.query("BEGIN");
        await producer.query(
          "UPDATE task SET status = $1, completion_summary = NULL WHERE id = $2",
          ["done", tasks[0].id],
        );
        const { rows } = await producer.query("SELECT pg_backend_pid() AS pid");
        const write = app.request("/api/task/bulk", {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            taskIds: tasks.map((task) => task.id),
            operation,
            value:
              operation === "updateStatus"
                ? "done"
                : operation === "updatePriority"
                  ? "high"
                  : operation === "updateAssignee"
                    ? member.user.id
                    : "2026-10-20T12:00:00.000Z",
          }),
        });
        try {
          await waitForBlockedWriter(rows[0].pid);
        } finally {
          await producer.query("COMMIT");
        }
        response = await write;
      } finally {
        await producer.query("ROLLBACK");
        producer.release();
      }
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: "TASK_WORKFLOW_POLICY",
        missingFields: ["completionSummary"],
      });
      for (const task of tasks) {
        const [persisted] = await db
          .select()
          .from(schema.taskTable)
          .where(eq(schema.taskTable.id, task.id));
        expect(persisted).toMatchObject({
          status: task.id === tasks[0].id ? "done" : task.status,
          priority: task.priority,
          userId: task.userId,
          dueDate: task.dueDate,
          version: task.version + (task.id === tasks[0].id ? 1 : 0),
        });
      }
    },
    15000,
  );

  it.each(["blocked", "done"])(
    "rejects move after concurrent %s state commits",
    async (status) => {
      const { app, member, project, tasks } = await fixture();
      const { project: destination } = await createProjectFixture({
        workspaceId: member.workspace.id,
      });
      const task = tasks[0];
      const producer = await getDatabasePool().connect();
      let response: Response;
      try {
        await producer.query("BEGIN");
        await producer.query(
          "UPDATE task SET status = $1, blocked_reason = $2, unblock_policy = $3 WHERE id = $4",
          [
            status,
            status === "blocked" ? "Human review" : null,
            status === "blocked" ? "human_required" : null,
            task.id,
          ],
        );
        const { rows } = await producer.query("SELECT pg_backend_pid() AS pid");
        const write = app.request(`/api/task/move/${task.id}`, {
          method: "PUT",
          headers,
          body: JSON.stringify({
            destinationProjectId: destination.id,
            destinationStatus: "to-do",
          }),
        });
        try {
          await waitForBlockedWriter(rows[0].pid);
        } finally {
          await producer.query("COMMIT");
        }
        response = await write;
      } finally {
        await producer.query("ROLLBACK");
        producer.release();
      }
      expect(response.status).toBe(409);
      const [persisted] = await db
        .select()
        .from(schema.taskTable)
        .where(eq(schema.taskTable.id, task.id));
      expect(persisted).toMatchObject({
        projectId: project.id,
        status,
        version: task.version + 1,
      });
      const [destinationAfter] = await db
        .select()
        .from(schema.projectTable)
        .where(eq(schema.projectTable.id, destination.id));
      expect(destinationAfter.lastTaskNumber).toBe(destination.lastTaskNumber);
    },
    15000,
  );

  it("rejects move when hierarchy is created after its graph check", async () => {
    const { app, member, project, tasks } = await fixture();
    await db
      .update(schema.taskTable)
      .set({ workItemType: "epic" })
      .where(eq(schema.taskTable.id, tasks[1].id));
    const { project: destination } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const holder = await getDatabasePool().connect();
    let move: Promise<Response> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM project WHERE id = $1 FOR UPDATE", [
        destination.id,
      ]);
      const { rows } = await holder.query("SELECT pg_backend_pid() AS pid");
      move = app.request(`/api/task/move/${tasks[0].id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          destinationProjectId: destination.id,
          destinationStatus: "to-do",
        }),
      });
      await waitForBlockedWriter(rows[0].pid);
      const relation = await app.request("/api/task-relation", {
        method: "POST",
        headers,
        body: JSON.stringify({
          sourceTaskId: tasks[1].id,
          targetTaskId: tasks[0].id,
          relationType: "subtask",
        }),
      });
      expect(relation.status).toBe(200);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    if (!move) throw new Error("Move request did not start");
    expect((await move).status).toBe(409);
    const [persisted] = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, tasks[0].id));
    expect(persisted).toMatchObject({
      projectId: project.id,
      version: tasks[0].version + 1,
    });
    const relations = await db.select().from(schema.taskRelationTable);
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({
      sourceTaskId: tasks[1].id,
      targetTaskId: tasks[0].id,
      relationType: "subtask",
    });
    const [destinationAfter] = await db
      .select()
      .from(schema.projectTable)
      .where(eq(schema.projectTable.id, destination.id));
    expect(destinationAfter.lastTaskNumber).toBe(destination.lastTaskNumber);
  }, 15000);
});
