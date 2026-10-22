import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { taskGroupEventTable } from "../../apps/api/src/database/schema";
import { subscribeToEvent } from "../../apps/api/src/events";
import { drainTaskGroupEvents } from "../../apps/api/src/events/task-group-worker";
import applyTaskGroup from "../../apps/api/src/task/controllers/apply-task-group";
import prepareTaskGroup from "../../apps/api/src/task/controllers/prepare-task-group";
import "../../apps/api/src/index";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const remote = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock(
  "../../apps/api/src/notification-preferences/delivery",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../apps/api/src/notification-preferences/delivery")
    >()),
    deliverNotification: remote.deliver,
  }),
);
let failNext = false;
subscribeToEvent("task.status_changed", async () => {
  if (failNext) {
    failNext = false;
    throw new Error("Controlled listener failure");
  }
});

describe("Durable bounded task group event delivery", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    remote.deliver.mockReset().mockResolvedValue(undefined);
    failNext = false;
  });
  async function fixture(count = 1) {
    const member = await createWorkspaceMember({ role: "owner" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [assignee] = await db
      .insert(schema.userTable)
      .values({
        id: "group-assignee",
        name: "Assignee",
        email: "group-assignee@example.test",
      })
      .returning();
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: member.workspace.id,
      userId: assignee!.id,
      role: "member",
      joinedAt: new Date(),
    });
    await db.insert(schema.taskTable).values(
      Array.from({ length: count }, (_, i) => ({
        projectId: project.id,
        number: i + 1,
        title: `Task${i}`,
        description: "Keep prose",
        status: "done",
        userId: assignee!.id,
      })),
    );
    const prepared = await prepareTaskGroup(
      project.id,
      { action: "archive_column", sourceStatus: "done" },
      member.user.id,
      member.workspace.id,
      "delivery",
    );
    await applyTaskGroup(
      project.id,
      String(prepared.operationId),
      member.user.id,
      member.workspace.id,
    );
    return { project };
  }
  it("listener retry creates one actual activity and notification, not duplicates", async () => {
    await fixture();
    failNext = true;
    expect(await drainTaskGroupEvents(1)).toBe(0);
    expect(await db.select().from(schema.activityTable)).toHaveLength(1);
    expect(await db.select().from(schema.notificationTable)).toHaveLength(1);
    const [pending] = await db.select().from(taskGroupEventTable);
    expect(pending.deliveredAt).toBeNull();
    expect(pending.attempts).toBe(1);
    await db.update(taskGroupEventTable).set({ nextAttemptAt: new Date(0) });
    expect(await drainTaskGroupEvents(1)).toBe(1);
    expect(await db.select().from(schema.activityTable)).toHaveLength(1);
    expect(await db.select().from(schema.notificationTable)).toHaveLength(1);
    expect(remote.deliver).toHaveBeenCalledOnce();
    const [delivered] = await db.select().from(taskGroupEventTable);
    expect(delivered.deliveredAt).not.toBeNull();
    expect(delivered.attempts).toBe(2);
  });
  it("expired process lease recovers persisted event after simulated worker restart", async () => {
    await fixture();
    await db
      .update(taskGroupEventTable)
      .set({ leaseToken: "old-process", leaseUntil: new Date(0) });
    expect(await drainTaskGroupEvents(1)).toBe(1);
    const [event] = await db.select().from(taskGroupEventTable);
    expect(event.leaseToken).toBeNull();
    expect(event.deliveredAt).not.toBeNull();
    expect(await db.select().from(schema.activityTable)).toHaveLength(1);
  });
  it("sixteen simultaneous drain requests maintain one active delivery across 16 events", async () => {
    await fixture(16);
    let active = 0;
    let maximum = 0;
    const deliver = vi.fn(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
    });
    const counts = await Promise.all(
      Array.from({ length: 16 }, () => drainTaskGroupEvents(25, deliver)),
    );
    expect(maximum).toBe(1);
    expect(counts.every((count) => count === 16)).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(16);
    expect(
      (await db.select().from(taskGroupEventTable)).every(
        (row) => row.deliveredAt !== null,
      ),
    ).toBe(true);
  });
  it("live lease is not stolen by another drain", async () => {
    await fixture();
    await db.update(taskGroupEventTable).set({
      leaseToken: "live-process",
      leaseUntil: new Date(Date.now() + 60_000),
    });
    const deliver = vi.fn();
    expect(await drainTaskGroupEvents(1, deliver)).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
    expect(await db.select().from(schema.activityTable)).toEqual([]);
  });
});
