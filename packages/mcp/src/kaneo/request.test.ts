import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boundedRegistrar, withOperation } from "./operation.js";
import { requestText } from "./request.js";

describe("logical operation transport", () => {
  let server: Server;
  let endpoint: string;
  let calls: string[];
  let keys: Array<string | undefined>;
  let delay: number;
  let bodyDelay: number;
  let status: number;
  let disconnect: boolean;
  let retryAfter: string;
  beforeEach(async () => {
    calls = [];
    keys = [];
    delay = 0;
    bodyDelay = 0;
    status = 200;
    disconnect = false;
    retryAfter = "60";
    server = createServer((req, res) => {
      calls.push(req.method ?? "GET");
      keys.push(req.headers["idempotency-key"] as string | undefined);
      if (disconnect) {
        disconnect = false;
        res.destroy();
        return;
      }
      setTimeout(() => {
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Content-Length": "2",
          "Retry-After": retryAfter,
        });
        res.flushHeaders();
        setTimeout(() => res.end("{}"), bodyDelay);
      }, delay);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
  });

  it("shares deadline across requests and prevents subsequent write", async () => {
    delay = 120;
    const started = performance.now();
    await expect(
      withOperation(
        async () => {
          await requestText(endpoint + "/one");
          await requestText(endpoint + "/two");
          await requestText(endpoint + "/write", { method: "POST" });
        },
        undefined,
        200,
      ),
    ).rejects.toMatchObject({ details: { category: "deadline" } });
    expect(performance.now() - started).toBeLessThan(450);
    expect(calls).toEqual(["GET", "GET"]);
  });

  it("passes SDK cancellation to response body and reports ambiguous write", async () => {
    bodyDelay = 1000;
    let callback: (...args: unknown[]) => Promise<unknown> = async () =>
      undefined;
    const serverMock = {
      registerTool: (_name: unknown, _config: unknown, cb: typeof callback) => {
        callback = cb;
      },
    };
    const register = boundedRegistrar(serverMock as never);
    register("write", {}, (() =>
      requestText(endpoint + "/write", { method: "POST" })) as never);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    const started = performance.now();
    try {
      await expect(
        callback({}, { signal: controller.signal }),
      ).rejects.toMatchObject({
        details: { category: "cancelled", attempts: 1, ambiguous_write: true },
      });
      expect(performance.now() - started).toBeLessThan(450);
      expect(calls).toEqual(["POST"]);
    } finally {
      clearTimeout(timer);
    }
  });

  it("does not wait beyond budget for Retry-After", async () => {
    status = 429;
    for (const value of ["60", new Date(Date.now() + 60_000).toUTCString()]) {
      retryAfter = value;
      calls = [];
      const started = performance.now();
      const result = await withOperation(
        () => requestText(endpoint + "/limited"),
        undefined,
        200,
      );
      expect(result.response.status).toBe(429);
      expect(result.diagnostics).toMatchObject({ attempts: 1, status: 429 });
      expect(performance.now() - started).toBeLessThan(200);
      expect(calls).toEqual(["GET"]);
    }
  });

  it("retries safe PATCH with same idempotency key", async () => {
    disconnect = true;
    const result = await requestText(endpoint + "/task/agent/task-id", {
      method: "PATCH",
      body: "{}",
    });
    expect(result.response.ok).toBe(true);
    expect(calls).toEqual(["PATCH", "PATCH"]);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it("does not retry unsafe write after reset", async () => {
    disconnect = true;
    await expect(
      requestText(endpoint + "/unsafe", { method: "POST" }),
    ).rejects.toMatchObject({
      details: { category: "transport", attempts: 1, ambiguous_write: true },
    });
    expect(calls).toEqual(["POST"]);
  });

  it("cancels reset retry backoff without another request", async () => {
    disconnect = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await expect(
        withOperation(() => requestText(endpoint + "/read"), controller.signal),
      ).rejects.toMatchObject({
        details: { category: "cancelled", attempts: 1, ambiguous_write: false },
      });
      expect(calls).toEqual(["GET"]);
    } finally {
      clearTimeout(timer);
    }
  });

  it("does not retry invalid TLS certificate", async () => {
    const error = new TypeError("fetch failed", {
      cause: { code: "CERT_HAS_EXPIRED" },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
    await expect(
      requestText("https://invalid.example/health"),
    ).rejects.toMatchObject({
      details: { category: "tls", attempts: 1, ambiguous_write: false },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
