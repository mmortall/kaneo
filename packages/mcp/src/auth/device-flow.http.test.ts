import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withOperation } from "../kaneo/operation.js";
import { pollDeviceAccessToken, requestDeviceCode } from "./device-flow.js";

describe("device authorization HTTP lifecycle", () => {
  let server: Server;
  let endpoint: string;
  let calls: string[];
  let bodyDelay: number;
  let tokenError: string;
  beforeEach(async () => {
    calls = [];
    bodyDelay = 0;
    tokenError = "authorization_pending";
    server = createServer((req, res) => {
      calls.push(req.url ?? "");
      req.resume();
      const code = {
        device_code: "fixture",
        user_code: "fixture",
        verification_uri: "https://verify.example.com",
        interval: 1,
        expires_in: 30,
      };
      const body = JSON.stringify(
        req.url?.endsWith("/code") ? code : { error: tokenError },
      );
      res.writeHead(req.url?.endsWith("/code") ? 200 : 400, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      });
      res.flushHeaders();
      const timer = setTimeout(() => {
        if (!res.destroyed) res.end(body);
      }, bodyDelay);
      res.on("close", () => clearTimeout(timer));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("bounds device-code response body inside original operation deadline", async () => {
    bodyDelay = 1000;
    const started = performance.now();
    await expect(
      withOperation(
        () => requestDeviceCode(endpoint, "fixture"),
        undefined,
        100,
      ),
    ).rejects.toMatchObject({ details: { category: "deadline", attempts: 1 } });
    expect(performance.now() - started).toBeLessThan(500);
    expect(calls).toEqual(["/api/auth/device/code"]);
  });

  it("cancels device-code body without retrying authorization POST", async () => {
    bodyDelay = 1000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await expect(
        withOperation(
          () => requestDeviceCode(endpoint, "fixture"),
          controller.signal,
        ),
      ).rejects.toMatchObject({
        details: { category: "cancelled", attempts: 1 },
      });
      expect(calls).toEqual(["/api/auth/device/code"]);
    } finally {
      clearTimeout(timer);
    }
  });

  it("cancels approval sleep without dispatching another token request", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    const started = performance.now();
    try {
      await expect(
        withOperation(
          () => pollDeviceAccessToken(endpoint, "fixture", "fixture", 1),
          controller.signal,
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(performance.now() - started).toBeLessThan(500);
      expect(calls).toEqual(["/api/auth/device/token"]);
    } finally {
      clearTimeout(timer);
    }
  });

  it("caps approval sleep at declared max wait even after slow_down", async () => {
    tokenError = "slow_down";
    const started = performance.now();
    await expect(
      pollDeviceAccessToken(endpoint, "fixture", "fixture", 1, {
        maxWaitMs: 120,
      }),
    ).rejects.toThrow("timed out waiting for approval");
    expect(performance.now() - started).toBeLessThan(500);
    expect(calls).toEqual(["/api/auth/device/token"]);
  });

  it("does not poll again after expired device code", async () => {
    tokenError = "expired_token";
    await expect(
      pollDeviceAccessToken(endpoint, "fixture", "fixture", 1),
    ).rejects.toThrow("Device code expired");
    expect(calls).toEqual(["/api/auth/device/token"]);
  });
});
