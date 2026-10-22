import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { MiddlewareHandler } from "hono";

const requests = new AsyncLocalStorage<{
  queries: number;
  databaseAcquireMs: number;
}>();
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();
export function recordDatabaseQuery() {
  const request = requests.getStore();
  if (request) request.queries++;
}
export function beginDatabaseAcquire() {
  const request = requests.getStore();
  const start = performance.now();
  return () => {
    if (request) request.databaseAcquireMs += performance.now() - start;
  };
}
export function performanceSnapshot() {
  const cpu = process.cpuUsage();
  return {
    uptimeSeconds: process.uptime(),
    memoryBytes: process.memoryUsage().rss,
    cpuUserMs: cpu.user / 1000,
    cpuSystemMs: cpu.system / 1000,
    eventLoopP95Ms: eventLoop.percentile(95) / 1e6,
    build: process.env.KANEO_BUILD_ID ?? "unknown",
  };
}
export const measureRequest: MiddlewareHandler = async (c, next) => {
  const supplied = c.req.header("X-Request-Id");
  const id =
    supplied && /^[\w.-]{1,64}$/.test(supplied) ? supplied : randomUUID();
  c.header("X-Request-Id", id);
  const start = performance.now();
  const context = { queries: 0, databaseAcquireMs: 0 };
  await requests.run(context, next);
  if (process.env.KANEO_PERFORMANCE_LOG === "true") {
    console.log(
      JSON.stringify({
        kind: "api_request",
        requestId: id,
        method: c.req.method,
        route: c.req.routePath,
        status: c.res.status,
        durationMs: Math.round(performance.now() - start),
        queries: context.queries,
        databaseAcquireMs: Math.round(context.databaseAcquireMs * 100) / 100,
        responseBytes: c.res.headers.get("Content-Length"),
      }),
    );
  }
};
