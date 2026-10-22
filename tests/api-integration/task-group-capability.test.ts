import { eq, sql } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { taskGroupEventTable } from "../../apps/api/src/database/schema";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

beforeEach(resetTestDatabase);
it.each(["archive_column", "activate_planned"] as const)(
  "advertised capability supports complete %s over HTTP with replay",
  async (action) => {
    const member = await createWorkspaceMember({ role: "owner" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const source = action === "archive_column" ? "done" : "planned";
    const target = action === "archive_column" ? "archived" : "to-do";
    await db.execute(sql`INSERT INTO task(id,project_id,number,title,description,status,version)
      SELECT 'capability-' || i,${project.id},i,'Reviewed ' || i,'Preserve content',
      CASE WHEN i <= 65 THEN ${source} ELSE 'in-progress' END,1 FROM generate_series(1,70) AS i`);
    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const capability = await app.request("/api/task/agent/capabilities");
    expect(capability.status).toBe(200);
    expect(await capability.json()).toMatchObject({ completeTaskGroups: true });
    const intent =
      action === "archive_column"
        ? { action, sourceStatus: source }
        : { action, targetStatus: target };
    const prepared = await app.request(
      `/api/task/agent/group-prepare/${project.id}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "capability-http",
        },
        body: JSON.stringify(intent),
      },
    );
    expect(prepared.status).toBe(200);
    const snapshot = await prepared.json();
    expect(snapshot.count).toBe(65);
    const responses = await Promise.all(
      Array.from({ length: 16 }, () =>
        app.request(
          `/api/task/agent/group-apply/${project.id}/${snapshot.operationId}`,
          { method: "POST" },
        ),
      ),
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        operationId: snapshot.operationId,
        applied: true,
        updatedCount: 65,
      });
    }
    const rows = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.projectId, project.id));
    expect(rows.filter((task) => task.status === target)).toHaveLength(65);
    expect(rows.filter((task) => task.status === "in-progress")).toHaveLength(
      5,
    );
    for (const task of rows) {
      expect(task.description).toBe("Preserve content");
      expect(task.version).toBe(task.status === target ? 2 : 1);
    }
    expect(await db.select().from(taskGroupEventTable)).toHaveLength(65);
  },
);
