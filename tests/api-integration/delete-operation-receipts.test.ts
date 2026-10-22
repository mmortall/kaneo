import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import {
  projectTaskOperationTable,
  taskGroupEventTable,
} from "../../apps/api/src/database/schema";
import { drainTaskGroupEvents } from "../../apps/api/src/events/task-group-worker";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const mocks = vi.hoisted(() => ({ emit: vi.fn(), cleanup: vi.fn() }));
vi.mock("../../apps/api/src/events", async (original) => ({
  ...(await original<typeof import("../../apps/api/src/events")>()),
  publishEvent: mocks.emit,
}));
vi.mock("../../apps/api/src/storage/cleanup-assets", async (original) => ({
  ...(await original<
    typeof import("../../apps/api/src/storage/cleanup-assets")
  >()),
  deleteS3Keys: mocks.cleanup,
}));
describe("Deletion operation receipts and durable effects", () => {
  beforeEach(resetTestDatabase);
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.cleanup.mockResolvedValue([
      { status: "fulfilled", value: undefined },
    ]);
  });
  async function fixture() {
    const member = await createWorkspaceMember({ role: "owner" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const tasks = await db
      .insert(schema.taskTable)
      .values(
        [1, 2, 3].map((number) => ({
          projectId: project.id,
          title: `Task ${number}`,
          description: `Prose ${number}`,
          number,
          status: "to-do",
        })),
      )
      .returning();
    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const selection = tasks
      .slice(0, 2)
      .map((task) => ({ id: task.id, version: task.version }));
    const request = (selected = selection, key = "delete-test") =>
      app.request(`/api/task/agent/delete/${project.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, tasks: selected }),
      });
    const receipt = (key = "delete-test") =>
      app.request(`/api/task/agent/delete/${project.id}/receipt?key=${key}`);
    const rows = () =>
      db
        .select()
        .from(schema.taskTable)
        .where(eq(schema.taskTable.projectId, project.id));
    return { app, member, project, tasks, selection, request, receipt, rows };
  }
  it("returns identical receipt to16 callers, persists effects once and recovers discarded response", async () => {
    const { request, receipt, rows, tasks } = await fixture();
    const replies = await Promise.all(
      Array.from({ length: 16 }, () => request()),
    );
    expect(replies.every((response) => response.status === 200)).toBe(true);
    const bodies = await Promise.all(
      replies.map((response) => response.json()),
    );
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(bodies[0]).toMatchObject({ success: true, deletedCount: 2 });
    expect(await rows()).toEqual([tasks[2]]);
    expect(await (await receipt()).json()).toEqual({ receipt: bodies[0] });
    expect(await db.select().from(projectTaskOperationTable)).toHaveLength(1);
    expect(await db.select().from(taskGroupEventTable)).toHaveLength(2);
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });
  it("normalizes selection order but rejects another body with committed key", async () => {
    const { request, selection, rows } = await fixture();
    const first = await (await request()).json();
    expect(await (await request([...selection].reverse())).json()).toEqual(
      first,
    );
    expect(
      (await request([{ id: selection[0]!.id, version: 99 }])).status,
    ).toBe(409);
    expect(await rows()).toHaveLength(1);
  });
  it("stale or foreign-project selections cannot produce receipt or delete any task", async () => {
    const { request, tasks, selection, receipt, rows, member } =
      await fixture();
    await db
      .update(schema.taskTable)
      .set({ description: "Newer text" })
      .where(eq(schema.taskTable.id, tasks[0]!.id));
    const before = await rows();
    expect((await request()).status).toBe(409);
    expect(await rows()).toEqual(before);
    expect(await (await receipt()).json()).toEqual({ receipt: null });
    const { project: other } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [foreign] = await db
      .insert(schema.taskTable)
      .values({ projectId: other.id, title: "Foreign", status: "to-do" })
      .returning();
    expect(
      (await request([{ id: foreign!.id, version: foreign!.version }])).status,
    ).toBe(409);
    expect(await db.select().from(projectTaskOperationTable)).toHaveLength(0);
    expect(await db.select().from(taskGroupEventTable)).toHaveLength(0);
  });
  it("scopes receipt to caller and current permission after tasks are gone", async () => {
    const { request, receipt, member } = await fixture();
    expect((await request()).status).toBe(200);
    const outsider = await createWorkspaceMember();
    mockAuthenticatedSession(outsider.user);
    expect((await receipt()).status).toBe(403);
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: member.workspace.id,
      userId: outsider.user.id,
      role: "owner",
      joinedAt: new Date(),
    });
    expect(await (await receipt()).json()).toEqual({ receipt: null });
    mockAuthenticatedSession(member.user);
    await db
      .update(schema.workspaceUserTable)
      .set({ role: "viewer" })
      .where(eq(schema.workspaceUserTable.userId, member.user.id));
    expect((await receipt()).status).toBe(403);
  });
  it("rolls task deletion back if outbox insert fails", async () => {
    const { request, receipt, rows } = await fixture();
    const before = await rows();
    await db.execute(
      sql`CREATE FUNCTION test_reject_delete_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected outbox failure'; END $$`,
    );
    await db.execute(
      sql`CREATE TRIGGER test_reject_delete_effect BEFORE INSERT ON task_group_event FOR EACH ROW EXECUTE FUNCTION test_reject_delete_effect()`,
    );
    try {
      expect((await request()).status).toBe(500);
    } finally {
      await db.execute(
        sql`DROP TRIGGER test_reject_delete_effect ON task_group_event`,
      );
      await db.execute(sql`DROP FUNCTION test_reject_delete_effect()`);
    }
    expect(await rows()).toEqual(before);
    expect(await (await receipt()).json()).toEqual({ receipt: null });
    expect(await db.select().from(taskGroupEventTable)).toHaveLength(0);
  });
  it("delivers durable deletion types and retries failed asset cleanup before acknowledgment", async () => {
    const { request, tasks, member, project } = await fixture();
    await db.insert(schema.assetTable).values({
      workspaceId: member.workspace.id,
      projectId: project.id,
      taskId: tasks[0]!.id,
      objectKey: "deleted-asset",
      filename: "file.png",
      mimeType: "image/png",
      size: 5,
    });
    await db.insert(schema.taskRelationTable).values({
      sourceTaskId: tasks[0]!.id,
      targetTaskId: tasks[2]!.id,
      relationType: "related",
    });
    expect((await request()).status).toBe(200);
    mocks.cleanup.mockResolvedValueOnce([
      { status: "rejected", reason: new Error("Injected S3 failure") },
    ]);
    const deliver = vi.fn().mockResolvedValue(undefined);
    expect(await drainTaskGroupEvents(25, deliver)).toBe(3);
    expect(
      deliver.mock.calls.filter((call) => call[0] === "task.deleted"),
    ).toHaveLength(2);
    expect(
      deliver.mock.calls.filter((call) => call[0] === "task-relation.deleted"),
    ).toHaveLength(1);
    const queued = await db.select().from(taskGroupEventTable);
    const asset = queued.find(
      (event) => event.payload.deliveryType === "asset.delete",
    )!;
    expect(asset.deliveredAt).toBeNull();
    expect(asset.attempts).toBe(1);
    await db
      .update(taskGroupEventTable)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(taskGroupEventTable.id, asset.id));
    expect(await drainTaskGroupEvents(25, deliver)).toBe(1);
    expect(mocks.cleanup).toHaveBeenCalledTimes(2);
    expect(
      (await db.select().from(taskGroupEventTable)).every(
        (event) => event.deliveredAt,
      ),
    ).toBe(true);
  });
});
