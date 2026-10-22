import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

describe("Move completion policy", () => {
  beforeEach(resetTestDatabase);

  it.each([null, "Verified completion"])(
    "checks completion evidence %s for done even when destination column is not final",
    async (completionSummary) => {
      const member = await createWorkspaceMember();
      const { project: source } = await createProjectFixture({
        workspaceId: member.workspace.id,
      });
      const { project: destination } = await createProjectFixture({
        workspaceId: member.workspace.id,
      });
      await db
        .update(schema.columnTable)
        .set({ isFinal: false })
        .where(
          and(
            eq(schema.columnTable.projectId, destination.id),
            eq(schema.columnTable.slug, "done"),
          ),
        );
      const [task] = await db
        .insert(schema.taskTable)
        .values({
          projectId: source.id,
          title: "Owned move fixture",
          number: 1,
          goal: "Keep completion evidence",
          acceptanceCriteria: "Done requires summary",
          status: "to-do",
          completionSummary,
        })
        .returning();
      mockAuthenticatedSession(member.user);
      const { app } = createApp();
      const response = await app.request(`/api/task/move/${task.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-kaneo-caller": "ai" },
        body: JSON.stringify({
          destinationProjectId: destination.id,
          destinationStatus: "done",
        }),
      });
      expect(response.status).toBe(completionSummary ? 200 : 409);
      if (!completionSummary)
        expect(await response.json()).toMatchObject({
          error: "TASK_WORKFLOW_POLICY",
          missingFields: ["completionSummary"],
        });
      const [persisted] = await db
        .select()
        .from(schema.taskTable)
        .where(eq(schema.taskTable.id, task.id));
      expect(persisted.projectId).toBe(
        completionSummary ? destination.id : source.id,
      );
      expect(persisted.status).toBe(completionSummary ? "done" : "to-do");
      expect(persisted.version).toBe(
        task.version + (completionSummary ? 1 : 0),
      );
    },
  );
});
