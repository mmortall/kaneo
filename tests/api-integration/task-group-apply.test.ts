import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import {
  projectTaskOperationTable,
  taskGroupEventTable,
} from "../../apps/api/src/database/schema";
import { drainTaskGroupEvents } from "../../apps/api/src/events/task-group-worker";
import { createApp } from "../../apps/api/src/index";
import applyTaskGroup from "../../apps/api/src/task/controllers/apply-task-group";
import prepareTaskGroup from "../../apps/api/src/task/controllers/prepare-task-group";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const events = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock("../../apps/api/src/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../apps/api/src/events")>()),
  publishEvent: events.publish,
}));
describe("Atomic complete task group application", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    events.publish.mockReset();
  });
  async function fixture(status = "done") {
    const member = await createWorkspaceMember({ role: "owner" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const tasks = await db
      .insert(schema.taskTable)
      .values(
        [1, 2].map((number) => ({
          projectId: project.id,
          number,
          title: `Task ${number}`,
          description: `Keep prose ${number}`,
          status,
          columnId: status === "done" ? columns.done.id : null,
          priority: "low",
          goal: "Goal",
          acceptanceCriteria: "Pass",
          completionSummary: "Completed",
          blockedReason: "Old reason",
          unblockPolicy: "human_required",
        })),
      )
      .returning();
    const prepare = () =>
      prepareTaskGroup(
        project.id,
        status === "planned"
          ? { action: "activate_planned", targetStatus: "in-progress" }
          : { action: "archive_column", sourceStatus: "done" },
        member.user.id,
        member.workspace.id,
        "group-apply",
      );
    const rows = () =>
      db
        .select()
        .from(schema.taskTable)
        .where(eq(schema.taskTable.projectId, project.id))
        .orderBy(schema.taskTable.number);
    const apply = (operationId: unknown, caller?: string) =>
      applyTaskGroup(
        project.id,
        String(operationId),
        member.user.id,
        member.workspace.id,
        caller,
      );
    return { member, project, columns, tasks, prepare, apply, rows };
  }
  it("archives all snapshot tasks once, preserving prose and emits only after commit", async () => {
    const { tasks, prepare, apply, rows } = await fixture();
    const prepared = await prepare();
    events.publish.mockImplementation(async () => {
      expect((await rows()).every((task) => task.status === "archived")).toBe(
        true,
      );
      expect(
        (await db.select().from(projectTaskOperationTable))[0].appliedAt,
      ).not.toBeNull();
    });
    const result = await apply(prepared.operationId, "ai");
    expect(result).toMatchObject({ applied: true, count: 2, updatedCount: 2 });
    const after = await rows();
    for (let i = 0; i < tasks.length; i++)
      expect(after[i]).toEqual({
        ...tasks[i],
        status: "archived",
        columnId: null,
        blockedReason: null,
        unblockPolicy: null,
        version: tasks[i].version + 1,
        updatedAt: after[i].updatedAt,
      });
    expect(await drainTaskGroupEvents(25, events.publish)).toBe(2);
    expect(events.publish).toHaveBeenCalledTimes(2);
    expect(await apply(prepared.operationId, "ai")).toEqual(result);
    expect(await prepare()).toEqual(result);
    expect(await rows()).toEqual(after);
    expect(await drainTaskGroupEvents(25, events.publish)).toBe(0);
    expect(events.publish).toHaveBeenCalledTimes(2);
    expect(
      (await db.select().from(projectTaskOperationTable))[0].snapshot,
    ).toEqual([]);
  });
  it("sixteen simultaneous applies return identical committed result and change each task once", async () => {
    const { tasks, prepare, apply, rows } = await fixture();
    const prepared = await prepare();
    const results = await Promise.all(
      Array.from({ length: 16 }, () => apply(prepared.operationId)),
    );
    for (const result of results) expect(result).toEqual(results[0]);
    expect((await rows()).map((task) => task.version)).toEqual(
      tasks.map((task) => task.version + 1),
    );
    expect(events.publish).not.toHaveBeenCalled();
    expect(await db.select().from(taskGroupEventTable)).toHaveLength(2);
    expect(await drainTaskGroupEvents(25, events.publish)).toBe(2);
    expect(events.publish).toHaveBeenCalledTimes(2);
  });
  it.each(["edit", "add", "remove", "leave", "join"])(
    "rejects %s since capture atomically",
    async (change) => {
      const { project, tasks, prepare, apply, rows } = await fixture();
      const prepared = await prepare();
      if (change === "edit")
        await db
          .update(schema.taskTable)
          .set({ title: "New title" })
          .where(eq(schema.taskTable.id, tasks[0].id));
      if (change === "add")
        await db.insert(schema.taskTable).values({
          projectId: project.id,
          number: 3,
          title: "New done",
          status: "done",
        });
      if (change === "remove")
        await db
          .delete(schema.taskTable)
          .where(eq(schema.taskTable.id, tasks[0].id));
      if (change === "leave")
        await db
          .update(schema.taskTable)
          .set({ status: "to-do" })
          .where(eq(schema.taskTable.id, tasks[0].id));
      if (change === "join") {
        const [other] = await db
          .insert(schema.taskTable)
          .values({
            projectId: project.id,
            number: 3,
            title: "New planned",
            status: "planned",
          })
          .returning();
        await db
          .update(schema.taskTable)
          .set({ status: "done" })
          .where(eq(schema.taskTable.id, other!.id));
      }
      const before = await rows();
      const ledger = await db.select().from(projectTaskOperationTable);
      await expect(apply(prepared.operationId)).rejects.toMatchObject({
        status: 409,
      });
      expect(await rows()).toEqual(before);
      expect(await db.select().from(projectTaskOperationTable)).toEqual(ledger);
      expect(events.publish).not.toHaveBeenCalled();
    },
  );
  it("planned activation uses destination column with one revision per task", async () => {
    const { tasks, columns, prepare, apply, rows } = await fixture("planned");
    const prepared = await prepare();
    expect(await apply(prepared.operationId, "ai")).toMatchObject({
      applied: true,
      updatedCount: 2,
    });
    const after = await rows();
    expect(
      after.every(
        (task) =>
          task.status === "in-progress" &&
          task.columnId === columns.inProgress.id,
      ),
    ).toBe(true);
    expect(after.map((task) => task.version)).toEqual(
      tasks.map((task) => task.version + 1),
    );
  });
  it("current permission revocation blocks even previously prepared operation", async () => {
    const { member, tasks, prepare, apply, rows } = await fixture();
    const prepared = await prepare();
    await db
      .update(schema.workspaceUserTable)
      .set({ role: "viewer" })
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, member.workspace.id),
          eq(schema.workspaceUserTable.userId, member.user.id),
        ),
      );
    await expect(apply(prepared.operationId)).rejects.toMatchObject({
      status: 403,
    });
    expect(await rows()).toEqual(tasks);
    expect(events.publish).not.toHaveBeenCalled();
  });
  it("changed final column policy rejects archive", async () => {
    const { columns, tasks, prepare, apply, rows } = await fixture();
    const prepared = await prepare();
    await db
      .update(schema.columnTable)
      .set({ isFinal: false })
      .where(eq(schema.columnTable.id, columns.done.id));
    await expect(apply(prepared.operationId)).rejects.toMatchObject({
      status: 409,
    });
    expect(await rows()).toEqual(tasks);
  });
  it("ledger write failure rolls back task changes with no emitted events", async () => {
    const { tasks, prepare, apply, rows } = await fixture();
    const prepared = await prepare();
    const before = await db.select().from(projectTaskOperationTable);
    await db.execute(
      sql.raw(
        "CREATE FUNCTION kaneo_test_fail_group_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled ledger failure'; END; $$",
      ),
    );
    try {
      await db.execute(
        sql.raw(
          "CREATE TRIGGER kaneo_test_fail_group_result BEFORE UPDATE ON project_task_operation FOR EACH ROW EXECUTE FUNCTION kaneo_test_fail_group_result()",
        ),
      );
      await expect(apply(prepared.operationId)).rejects.toThrow();
      expect(await rows()).toEqual(tasks);
      expect(await db.select().from(projectTaskOperationTable)).toEqual(before);
      expect(events.publish).not.toHaveBeenCalled();
    } finally {
      await db.execute(
        sql.raw(
          "DROP TRIGGER IF EXISTS kaneo_test_fail_group_result ON project_task_operation",
        ),
      );
      await db.execute(sql.raw("DROP FUNCTION kaneo_test_fail_group_result()"));
    }
    expect(await apply(prepared.operationId)).toMatchObject({ applied: true });
  });
  it("delivery failure leaves committed tasks and durable retry without duplicate business writes", async () => {
    const { tasks, prepare, apply, rows } = await fixture();
    const prepared = await prepare();
    const result = await apply(prepared.operationId);
    events.publish.mockRejectedValueOnce(
      new Error("Controlled delivery failure"),
    );
    expect(await drainTaskGroupEvents(1, events.publish)).toBe(0);
    const after = await rows();
    expect(after.map((task) => task.version)).toEqual(
      tasks.map((task) => task.version + 1),
    );
    expect(await apply(prepared.operationId)).toEqual(result);
    expect(await rows()).toEqual(after);
    const queued = await db.select().from(taskGroupEventTable);
    expect(queued).toHaveLength(2);
    expect(queued.every((row) => row.deliveredAt === null)).toBe(true);
    await db.update(taskGroupEventTable).set({ nextAttemptAt: new Date(0) });
    expect(await drainTaskGroupEvents(25, events.publish)).toBe(2);
    expect(await rows()).toEqual(after);
  });
  it("actual HTTP prepare/apply returns bounded result and stale conflict is visible", async () => {
    const { member, project, tasks, rows } = await fixture();
    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const prepare = await app.request(
      `/api/task/agent/group-prepare/${project.id}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "http-group",
        },
        body: JSON.stringify({
          action: "archive_column",
          sourceStatus: "done",
        }),
      },
    );
    expect(prepare.status).toBe(200);
    const prepared = await prepare.json();
    expect(prepared).not.toHaveProperty("snapshot");
    await db
      .update(schema.taskTable)
      .set({ title: "New title" })
      .where(eq(schema.taskTable.id, tasks[0].id));
    const before = await rows();
    const response = await app.request(
      `/api/task/agent/group-apply/${project.id}/${prepared.operationId}`,
      { method: "POST" },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "TASK_CONFLICT" });
    expect(await rows()).toEqual(before);
  });
  it("AI workflow failure is atomic; explicit human operation remains compatible", async () => {
    const { tasks, prepare, apply, rows } = await fixture();
    await db
      .update(schema.taskTable)
      .set({ goal: null })
      .where(eq(schema.taskTable.id, tasks[0].id));
    const prepared = await prepare();
    const before = await rows();
    await expect(apply(prepared.operationId, "ai")).rejects.toMatchObject({
      status: 409,
    });
    expect(await rows()).toEqual(before);
    expect(events.publish).not.toHaveBeenCalled();
    expect(await apply(prepared.operationId)).toMatchObject({
      applied: true,
      updatedCount: 2,
    });
  });
  it("expired snapshot cannot apply and new preparation compacts old payload but retains key", async () => {
    const { member, project, tasks, prepare, apply, rows } = await fixture();
    const prepared = await prepare();
    await db
      .update(projectTaskOperationTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(projectTaskOperationTable.id, String(prepared.operationId)));
    await expect(apply(prepared.operationId)).rejects.toMatchObject({
      status: 410,
    });
    await prepareTaskGroup(
      project.id,
      { action: "archive_column", sourceStatus: "done" },
      member.user.id,
      member.workspace.id,
      "new-key",
    );
    const [old] = await db
      .select()
      .from(projectTaskOperationTable)
      .where(eq(projectTaskOperationTable.id, String(prepared.operationId)));
    expect(old.snapshot).toEqual([]);
    expect(old.result.count).toBe(2);
    expect(old.appliedAt).toBeNull();
    await expect(prepare()).rejects.toMatchObject({ status: 410 });
    expect(await rows()).toEqual(tasks);
  });
  it("empty group records durable success with no task events", async () => {
    const { project, prepare, apply } = await fixture();
    await db
      .delete(schema.taskTable)
      .where(eq(schema.taskTable.projectId, project.id));
    const prepared = await prepare();
    const result = await apply(prepared.operationId);
    expect(result).toMatchObject({ applied: true, count: 0, updatedCount: 0 });
    expect(await apply(prepared.operationId)).toEqual(result);
    expect(events.publish).not.toHaveBeenCalled();
  });
});
