import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { getDatabasePool, schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import * as hierarchy from "../../apps/api/src/task-relation/work-item-hierarchy";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

describe("Concurrent hierarchy type changes", () => {
  beforeEach(resetTestDatabase);

  it.each([
    ["PUT", "PUT"],
    ["PATCH", "PATCH"],
    ["PUT", "PATCH"],
    ["PATCH", "PUT"],
  ])(
    "serializes parent %s and child %s type changes",
    async (parentMethod, childMethod) => {
      const member = await createWorkspaceMember();
      const { project } = await createProjectFixture({
        workspaceId: member.workspace.id,
      });
      const tasks = await db
        .insert(schema.taskTable)
        .values(
          [
            { id: "type-parent", workItemType: "epic" as const, number: 1 },
            { id: "type-child", workItemType: "task" as const, number: 2 },
          ].map((task) => ({
            ...task,
            projectId: project.id,
            title: task.id,
            goal: "Preserve hierarchy",
            acceptanceCriteria: "Concurrent types remain compatible",
          })),
        )
        .returning();
      await db.insert(schema.taskRelationTable).values({
        sourceTaskId: tasks[0].id,
        targetTaskId: tasks[1].id,
        relationType: "subtask",
      });
      mockAuthenticatedSession(member.user);
      const { app } = createApp();
      let validatedChild = false;
      let reachedParent!: () => void;
      let releaseParent!: () => void;
      const reached = new Promise<void>((resolve) => {
        reachedParent = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releaseParent = resolve;
      });
      const validate = hierarchy.assertWorkItemTypeChangeAllowed;
      vi.spyOn(hierarchy, "assertWorkItemTypeChangeAllowed").mockImplementation(
        async (...args) => {
          await validate(...args);
          if (args[0] === tasks[0].id) {
            reachedParent();
            await gate;
          } else validatedChild = true;
        },
      );
      const write = (task: (typeof tasks)[number], method: string) =>
        app.request(
          method === "PATCH"
            ? `/api/task/agent/${task.id}`
            : `/api/task/${task.id}`,
          {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...(method === "PUT"
                ? {
                    title: task.title,
                    description: "",
                    status: task.status,
                    priority: task.priority,
                    position: task.position,
                    projectId: task.projectId,
                  }
                : {}),
              expectedVersion: task.version,
              workItemType: "sub_epic",
            }),
          },
        );
      const parent = write(tasks[0], parentMethod);
      await reached;
      const child = write(tasks[1], childMethod);
      try {
        await vi.waitFor(
          async () => {
            const { rows } = await getDatabasePool().query(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%project%for update%') AS waiting",
            );
            expect(validatedChild || rows[0].waiting).toBe(true);
          },
          { timeout: 3000 },
        );
      } finally {
        releaseParent();
      }
      const responses = await Promise.all([parent, child]);
      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 409,
      ]);
      const persisted = await db.select().from(schema.taskTable);
      const byId = new Map(persisted.map((task) => [task.id, task]));
      expect(
        hierarchy.isAllowedParentChild(
          byId.get(tasks[0].id)!.workItemType,
          byId.get(tasks[1].id)!.workItemType,
        ),
      ).toBe(true);
    },
    15000,
  );
});
