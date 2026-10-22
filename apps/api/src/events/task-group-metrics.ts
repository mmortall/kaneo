import { isNull, sql } from "drizzle-orm";
import db from "../database";
import { taskGroupEventTable } from "../database/schema";

type Sample = {
  pending: number;
  attemptedPending: number;
  leased: number;
  delayed: number;
  oldestCreatedAt: Date | string | null;
};
let sample: Sample | undefined;
let sampledAt: number | undefined;
let lastRefreshFailed = false;
let refreshing: Promise<void> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;
let generation = 0;

/** Return cached aggregates; diagnostics requests never scan the queue. */
export function taskGroupQueueSnapshot() {
  return {
    pending: sample?.pending ?? null,
    attemptedPending: sample?.attemptedPending ?? null,
    leased: sample?.leased ?? null,
    delayed: sample?.delayed ?? null,
    oldestPendingAgeSeconds: sample?.oldestCreatedAt
      ? Math.max(
          0,
          (Date.now() - new Date(sample.oldestCreatedAt).getTime()) / 1000,
        )
      : null,
    sampledAt:
      sampledAt === undefined ? null : new Date(sampledAt).toISOString(),
    stale:
      sampledAt === undefined ||
      lastRefreshFailed ||
      Date.now() - sampledAt > 15_000,
    lastRefreshFailed,
  };
}

/** Coalesce readers and bound SQL execution independently from event delivery. */
export function refreshTaskGroupMetrics(): Promise<void> {
  if (!refreshing) {
    refreshing = db
      .transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '500ms'`);
        const [result] = await tx
          .select({
            pending: sql<number>`count(*)::int`,
            attemptedPending: sql<number>`count(*) FILTER (WHERE ${taskGroupEventTable.attempts} > 0)::int`,
            leased: sql<number>`count(*) FILTER (WHERE ${taskGroupEventTable.leaseUntil} > now())::int`,
            delayed: sql<number>`count(*) FILTER (WHERE ${taskGroupEventTable.nextAttemptAt} > now())::int`,
            oldestCreatedAt: sql<
              Date | string | null
            >`min(${taskGroupEventTable.createdAt})`,
          })
          .from(taskGroupEventTable)
          .where(isNull(taskGroupEventTable.deliveredAt));
        sample = result;
        sampledAt = Date.now();
        lastRefreshFailed = false;
      })
      .catch(() => {
        lastRefreshFailed = true;
      })
      .finally(() => {
        refreshing = undefined;
      });
  }
  return refreshing;
}

export function startTaskGroupMetrics() {
  if (started) return;
  started = true;
  const currentGeneration = ++generation;
  const tick = async () => {
    await refreshTaskGroupMetrics();
    if (started && generation === currentGeneration) {
      timer = setTimeout(tick, 5_000);
      timer.unref();
    }
  };
  void tick();
}

export function stopTaskGroupMetrics() {
  started = false;
  generation++;
  if (timer) clearTimeout(timer);
  timer = undefined;
}
