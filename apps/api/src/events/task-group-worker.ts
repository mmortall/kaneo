import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import db from "../database";
import { taskGroupEventTable } from "../database/schema";
import { deleteS3Keys } from "../storage/cleanup-assets";
import { eventContext, publishEventAndWait } from "./index";
import {
  startTaskGroupMetrics,
  stopTaskGroupMetrics,
} from "./task-group-metrics";

let running: Promise<number> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;
let generation = 0;

async function drain(limit: number, deliver: typeof publishEventAndWait) {
  let delivered = 0;
  for (let i = 0; i < limit; i++) {
    const token = randomUUID();
    const claimed = await db.transaction(async (tx) => {
      const [event] = await tx
        .select()
        .from(taskGroupEventTable)
        .where(
          and(
            isNull(taskGroupEventTable.deliveredAt),
            lte(taskGroupEventTable.nextAttemptAt, new Date()),
            or(
              isNull(taskGroupEventTable.leaseUntil),
              lte(taskGroupEventTable.leaseUntil, new Date()),
            ),
          ),
        )
        .orderBy(
          asc(taskGroupEventTable.nextAttemptAt),
          asc(taskGroupEventTable.id),
        )
        .limit(1)
        .for("update", { skipLocked: true });
      if (!event) return undefined;
      const [row] = await tx
        .update(taskGroupEventTable)
        .set({
          leaseToken: token,
          leaseUntil: new Date(Date.now() + 300_000),
          attempts: sql`${taskGroupEventTable.attempts} + 1`,
        })
        .where(eq(taskGroupEventTable.id, event.id))
        .returning();
      return row;
    });
    if (!claimed) break;
    try {
      await eventContext.run(
        { initiatorId: String(claimed.payload.initiatorId ?? "") },
        async () => {
          const type = claimed.payload.deliveryType;
          if (type === "asset.delete") {
            if (typeof claimed.payload.objectKey !== "string")
              throw new Error("Invalid asset deletion intent");
            const results = await deleteS3Keys([claimed.payload.objectKey]);
            if (results.some((result) => result.status === "rejected"))
              throw new Error("Asset deletion failed");
          } else if (
            type === "task.deleted" ||
            type === "task-relation.deleted"
          )
            await deliver(type, claimed.payload);
          else if (type === undefined)
            await deliver("task.status_changed", claimed.payload);
          else throw new Error("Unsupported durable event type");
        },
      );
      const saved = await db
        .update(taskGroupEventTable)
        .set({ deliveredAt: new Date(), leaseToken: null, leaseUntil: null })
        .where(
          and(
            eq(taskGroupEventTable.id, claimed.id),
            eq(taskGroupEventTable.leaseToken, token),
          ),
        )
        .returning({ id: taskGroupEventTable.id });
      delivered += saved.length;
    } catch (error) {
      console.error("Task group event delivery failed", {
        errorType: error instanceof Error ? error.name : "Unknown",
      });
      await db
        .update(taskGroupEventTable)
        .set({
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: new Date(
            Date.now() +
              Math.min(60_000, 1000 * 2 ** Math.min(claimed.attempts - 1, 6)),
          ),
        })
        .where(
          and(
            eq(taskGroupEventTable.id, claimed.id),
            eq(taskGroupEventTable.leaseToken, token),
          ),
        );
    }
  }
  return delivered;
}

/** One in-flight event per process; no database transaction spans subscriber calls. */
export function drainTaskGroupEvents(
  limit = 25,
  deliver = publishEventAndWait,
) {
  if (!running) {
    running = drain(limit, deliver).finally(() => {
      running = undefined;
    });
  }
  return running;
}

export function startTaskGroupEventWorker() {
  if (started) return;
  started = true;
  const currentGeneration = ++generation;
  startTaskGroupMetrics();
  const tick = async () => {
    try {
      await drainTaskGroupEvents();
    } catch (error) {
      console.error("Task group event worker failed", {
        errorType: error instanceof Error ? error.name : "Unknown",
      });
    }
    if (started && generation === currentGeneration) {
      timer = setTimeout(tick, 250);
      timer.unref();
    }
  };
  void tick();
}

export function stopTaskGroupEventWorker() {
  started = false;
  generation++;
  stopTaskGroupMetrics();
  if (timer) clearTimeout(timer);
  timer = undefined;
}
