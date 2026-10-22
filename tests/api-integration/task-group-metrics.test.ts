import { performance } from "node:perf_hooks";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import db, { getDatabase, schema } from "../../apps/api/src/database";
import { taskGroupEventTable } from "../../apps/api/src/database/schema";
import {
  refreshTaskGroupMetrics,
  taskGroupQueueSnapshot,
} from "../../apps/api/src/events/task-group-metrics";
import { createApp } from "../../apps/api/src/index";
import applyTaskGroup from "../../apps/api/src/task/controllers/apply-task-group";
import prepareTaskGroup from "../../apps/api/src/task/controllers/prepare-task-group";
import { mockAnonymousSession, mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

beforeEach(resetTestDatabase);
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const member = await createWorkspaceMember({ role: "owner" });
  const { project } = await createProjectFixture({
    workspaceId: member.workspace.id,
  });
  await db.insert(schema.taskTable).values(
    Array.from({ length: 4 }, (_, i) => ({
      projectId: project.id,
      number: i + 1,
      title: `Private task ${i}`,
      description: "Private prose",
      status: "done",
    })),
  );
  const snapshot = await prepareTaskGroup(
    project.id,
    { action: "archive_column", sourceStatus: "done" },
    member.user.id,
    member.workspace.id,
    "metrics",
  );
  await applyTaskGroup(
    project.id,
    String(snapshot.operationId),
    member.user.id,
    member.workspace.id,
  );
  const events = await db
    .select()
    .from(taskGroupEventTable)
    .orderBy(taskGroupEventTable.id);
  return { member, events };
}

it("counts pending, attempted, leased, delayed and oldest pending event while excluding delivered", async () => {
  const { events } = await fixture();
  await db
    .update(taskGroupEventTable)
    .set({ deliveredAt: new Date(), createdAt: new Date(0) })
    .where(eq(taskGroupEventTable.id, events[0].id));
  await db
    .update(taskGroupEventTable)
    .set({
      attempts: 1,
      nextAttemptAt: new Date(Date.now() + 60_000),
      createdAt: new Date(Date.now() - 60_000),
    })
    .where(eq(taskGroupEventTable.id, events[1].id));
  await db
    .update(taskGroupEventTable)
    .set({
      attempts: 1,
      leaseToken: "private-lease-token",
      leaseUntil: new Date(Date.now() + 60_000),
    })
    .where(eq(taskGroupEventTable.id, events[2].id));
  await refreshTaskGroupMetrics();
  const metrics = taskGroupQueueSnapshot();
  expect(metrics).toMatchObject({
    pending: 3,
    attemptedPending: 2,
    leased: 1,
    delayed: 1,
    stale: false,
    lastRefreshFailed: false,
  });
  expect(metrics.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(59);
  expect(metrics.oldestPendingAgeSeconds).toBeLessThan(70);
  expect(Object.keys(metrics).sort()).toEqual(
    [
      "pending",
      "attemptedPending",
      "leased",
      "delayed",
      "oldestPendingAgeSeconds",
      "sampledAt",
      "stale",
      "lastRefreshFailed",
    ].sort(),
  );
  expect(JSON.stringify(metrics)).not.toMatch(
    /private|Private|operationId|taskId|projectId|payload/,
  );
});

it("coalesces sixteen samples and returns empty queue without scanning again on snapshot read", async () => {
  const transaction = vi.spyOn(getDatabase(), "transaction");
  await Promise.all(
    Array.from({ length: 16 }, () => refreshTaskGroupMetrics()),
  );
  expect(transaction).toHaveBeenCalledOnce();
  for (let i = 0; i < 16; i++)
    expect(taskGroupQueueSnapshot()).toMatchObject({
      pending: 0,
      oldestPendingAgeSeconds: null,
      stale: false,
    });
  expect(transaction).toHaveBeenCalledOnce();
});

it("preserves last successful sample but explicitly marks failed refresh stale and recovers", async () => {
  await fixture();
  await refreshTaskGroupMetrics();
  const before = taskGroupQueueSnapshot();
  const transaction = vi
    .spyOn(getDatabase(), "transaction")
    .mockRejectedValueOnce(new Error("Controlled query failure"));
  await refreshTaskGroupMetrics();
  expect(taskGroupQueueSnapshot()).toMatchObject({
    pending: 4,
    sampledAt: before.sampledAt,
    stale: true,
    lastRefreshFailed: true,
  });
  transaction.mockRestore();
  await refreshTaskGroupMetrics();
  expect(taskGroupQueueSnapshot()).toMatchObject({
    pending: 4,
    stale: false,
    lastRefreshFailed: false,
  });
});

it("marks old sample stale without database access", async () => {
  await refreshTaskGroupMetrics();
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 16_000);
  expect(taskGroupQueueSnapshot()).toMatchObject({
    pending: 0,
    stale: true,
    lastRefreshFailed: false,
  });
});

it("real database lock times out metrics SQL and preserves explicit stale sample", async () => {
  await fixture();
  await refreshTaskGroupMetrics();
  const before = taskGroupQueueSnapshot();
  let acquired!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = db.transaction(async (tx) => {
    await tx.execute(sql`LOCK TABLE task_group_event IN ACCESS EXCLUSIVE MODE`);
    acquired();
    await gate;
  });
  try {
    await ready;
    const started = performance.now();
    await refreshTaskGroupMetrics();
    expect(performance.now() - started).toBeLessThan(1500);
    expect(taskGroupQueueSnapshot()).toMatchObject({
      pending: 4,
      sampledAt: before.sampledAt,
      stale: true,
      lastRefreshFailed: true,
    });
  } finally {
    release();
    await blocker;
  }
  await refreshTaskGroupMetrics();
  expect(taskGroupQueueSnapshot()).toMatchObject({
    pending: 4,
    stale: false,
    lastRefreshFailed: false,
  });
});

it("authenticated diagnostics exposes cached aggregates and anonymous requests stay rejected", async () => {
  const { member } = await fixture();
  await refreshTaskGroupMetrics();
  mockAuthenticatedSession(member.user);
  const { app } = createApp();
  const response = await app.request("/api/diagnostics");
  expect(response.status).toBe(200);
  expect((await response.json()).events.taskGroups).toMatchObject({
    pending: 4,
    stale: false,
  });
  mockAnonymousSession();
  const anonymous = await app.request("/api/diagnostics");
  expect(anonymous.status).toBe(401);
});
