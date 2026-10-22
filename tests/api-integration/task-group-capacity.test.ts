import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { eq, sql } from "drizzle-orm";
import { beforeEach, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import {
  projectTaskOperationTable,
  taskGroupEventTable,
} from "../../apps/api/src/database/schema";
import { subscribeToEvent } from "../../apps/api/src/events";
import {
  refreshTaskGroupMetrics,
  taskGroupQueueSnapshot,
} from "../../apps/api/src/events/task-group-metrics";
import { drainTaskGroupEvents } from "../../apps/api/src/events/task-group-worker";
import applyTaskGroup from "../../apps/api/src/task/controllers/apply-task-group";
import prepareTaskGroup from "../../apps/api/src/task/controllers/prepare-task-group";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const inline = vi.fn(async () => {});
subscribeToEvent("task.status_changed", inline);
beforeEach(async () => {
  await resetTestDatabase();
  inline.mockClear();
});

it.each([4344, 20000])(
  "complete groups on %i tasks preserve content with sixteen duplicate applies",
  async (size) => {
    const startedAt = new Date().toISOString();
    const member = await createWorkspaceMember({ role: "owner" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const doneCount = Math.floor(size / 2);
    const plannedCount = Math.floor(size / 4);
    await db.execute(sql`INSERT INTO task(id, project_id, number, title, description, goal, acceptance_criteria, completion_summary, status, version)
    SELECT 'capacity-' || i, ${project.id}, i, 'Task ' || i, repeat('Keep large prose ', 100),
      'Goal ' || i, 'Criteria ' || i, 'Result ' || i,
      CASE WHEN i <= ${doneCount} THEN 'done' WHEN i <= ${doneCount + plannedCount} THEN 'planned' ELSE 'to-do' END, 1
    FROM generate_series(1, ${size}) AS i`);
    async function contentDigest() {
      const rows = await db.execute(sql`SELECT md5(jsonb_agg(
      to_jsonb(t) - ARRAY['status','column_id','version','updated_at','blocked_reason','unblock_policy']
      ORDER BY t.id)::text) AS digest FROM task t WHERE project_id = ${project.id}`);
      return rows.rows[0].digest;
    }
    const before = await contentDigest();
    const measurements = [];
    for (const [intent, count, key] of [
      [
        { action: "archive_column", sourceStatus: "done" },
        doneCount,
        "archive",
      ],
      [
        { action: "activate_planned", targetStatus: "to-do" },
        plannedCount,
        "activate",
      ],
    ] as const) {
      const prepareStart = performance.now();
      const snapshot = await prepareTaskGroup(
        project.id,
        intent,
        member.user.id,
        member.workspace.id,
        key,
      );
      const prepareMs = performance.now() - prepareStart;
      expect(snapshot.count).toBe(count);
      expect(JSON.stringify(snapshot).length).toBeLessThan(1000);
      const durations: number[] = [];
      const start = performance.now();
      const results = await Promise.all(
        Array.from({ length: 16 }, async () => {
          const started = performance.now();
          const result = await applyTaskGroup(
            project.id,
            String(snapshot.operationId),
            member.user.id,
            member.workspace.id,
          );
          durations.push(performance.now() - started);
          return result;
        }),
      );
      for (const result of results) expect(result).toEqual(results[0]);
      expect(results[0]).toMatchObject({ applied: true, updatedCount: count });
      expect(JSON.stringify(results[0]).length).toBeLessThan(1000);
      expect(inline).not.toHaveBeenCalled();
      const [operation] = await db
        .select()
        .from(projectTaskOperationTable)
        .where(eq(projectTaskOperationTable.id, String(snapshot.operationId)));
      expect(operation.snapshot).toEqual([]);
      const [eventCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(taskGroupEventTable)
        .where(
          eq(taskGroupEventTable.operationId, String(snapshot.operationId)),
        );
      expect(eventCount.count).toBe(count);
      durations.sort((a, b) => a - b);
      expect(durations.every((duration) => duration < 20_000)).toBe(true);
      measurements.push({
        action: key,
        count,
        prepareMs,
        duplicateBurstMs: performance.now() - start,
        minimumMs: durations[0],
        maximumMs: durations.at(-1),
      });
    }
    expect(await contentDigest()).toBe(before);
    const rows = await db
      .select({
        status: schema.taskTable.status,
        version: schema.taskTable.version,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.taskTable)
      .where(eq(schema.taskTable.projectId, project.id))
      .groupBy(schema.taskTable.status, schema.taskTable.version);
    expect(rows).toEqual(
      expect.arrayContaining([
        { status: "archived", version: 2, count: doneCount },
        { status: "to-do", version: 2, count: plannedCount },
        { status: "to-do", version: 1, count: size - doneCount - plannedCount },
      ]),
    );
    expect(rows).toHaveLength(3);
    let active = 0;
    let maximumActive = 0;
    const deliver = vi.fn(async () => {
      active++;
      maximumActive = Math.max(active, maximumActive);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
    });
    const delivered = await Promise.all(
      Array.from({ length: 16 }, () => drainTaskGroupEvents(25, deliver)),
    );
    expect(delivered.every((count) => count === 25)).toBe(true);
    expect(maximumActive).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(25);
    const backlog = await db.execute(
      sql`SELECT count(*)::int AS count FROM task_group_event WHERE delivered_at IS NULL`,
    );
    expect(backlog.rows[0].count).toBe(doneCount + plannedCount - 25);
    const metricsStarted = performance.now();
    await refreshTaskGroupMetrics();
    const metricsMs = performance.now() - metricsStarted;
    expect(taskGroupQueueSnapshot()).toMatchObject({
      pending: doneCount + plannedCount - 25,
      attemptedPending: 0,
      leased: 0,
      delayed: 0,
      stale: false,
      lastRefreshFailed: false,
    });
    const directory = resolve(
      process.cwd(),
      "../../.cache/reliability-release",
    );
    mkdirSync(directory, { recursive: true });
    const sources = [
      "apps/api/src/task/controllers/apply-task-group.ts",
      "apps/api/src/task/controllers/prepare-task-group.ts",
      "apps/api/src/events/task-group-worker.ts",
      "apps/api/src/events/task-group-metrics.ts",
    ];
    writeFileSync(
      resolve(directory, `task-group-capacity-${size}.json`),
      JSON.stringify(
        {
          startedAt,
          endedAt: new Date().toISOString(),
          fixture: size,
          measurements,
          maximumActive,
          metricsMs,
          queueMetrics: taskGroupQueueSnapshot(),
          durablePending: backlog.rows[0].count,
          responseLimitBytes: 1000,
          scope:
            "Isolated PostgreSQL controller duplicate bursts, controlled 25-event delivery; not sustained HTTP load or full backlog drain",
          sourceSha256: Object.fromEntries(
            sources.map((name) => [
              name,
              createHash("sha256")
                .update(readFileSync(resolve(process.cwd(), "../..", name)))
                .digest("hex"),
            ]),
          ),
        },
        null,
        2,
      ),
    );
  },
  120_000,
);
