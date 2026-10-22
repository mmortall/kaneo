import { afterEach, describe, expect, it, vi } from "vitest";
import { KaneoClient } from "./client.js";
import { withOperation } from "./operation.js";

describe("KaneoClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("replays relation writes only when API advertises durable support", async () => {
    const auth = {
      getAccessToken: vi.fn().mockResolvedValue("key"),
      usingApiKey: true,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"relationIdempotency":true}'))
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(new Response('{"id":"relation"}'));
    globalThis.fetch = fetchMock as typeof fetch;
    const client = new KaneoClient({
      baseUrl: "http://127.0.0.1:1337",
      auth: auth as never,
    });
    expect(
      await client.json("/api/task-relation", { method: "POST", body: "{}" }),
    ).toEqual({ id: "relation" });
    const keys = fetchMock.mock.calls
      .slice(1)
      .map((call) =>
        new Headers((call[1] as RequestInit).headers).get("Idempotency-Key"),
      );
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    fetchMock
      .mockReset()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValue(new Response("down", { status: 503 }));
    const legacy = new KaneoClient({
      baseUrl: "http://127.0.0.1:1337",
      auth: auth as never,
    });
    await expect(
      legacy.json("/api/task-relation", { method: "POST", body: "{}" }),
    ).rejects.toThrow("down");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      new Headers((fetchMock.mock.calls[1][1] as RequestInit).headers).has(
        "Idempotency-Key",
      ),
    ).toBe(false);
  });

  it("keeps OAuth refresh inside original operation deadline", async () => {
    const auth = {
      getAccessToken: vi
        .fn()
        .mockResolvedValueOnce("expired")
        .mockImplementationOnce(() => new Promise(() => {})),
      clearToken: vi.fn().mockResolvedValue(undefined),
      usingApiKey: false,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("unauthorized", { status: 401 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const client = new KaneoClient({
      baseUrl: "https://api.example.com",
      auth: auth as never,
    });
    const started = performance.now();
    await expect(
      withOperation(
        () => client.json("/task/agent/task", { method: "PATCH", body: "{}" }),
        undefined,
        150,
      ),
    ).rejects.toMatchObject({
      details: {
        category: "deadline",
        stage: "authentication",
        ambiguous_write: false,
      },
    });
    expect(performance.now() - started).toBeLessThan(450);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(auth.clearToken).toHaveBeenCalledTimes(1);
    expect(auth.clearToken).toHaveBeenCalledWith("expired");
  });

  it("retains structured conflict version and never retries", async () => {
    const auth = {
      getAccessToken: vi.fn().mockResolvedValue("key"),
      usingApiKey: true,
    };
    const body = {
      error: "TASK_CONFLICT",
      currentVersion: 7,
      message: "Task changed",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(body), { status: 409 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const client = new KaneoClient({
      baseUrl: "https://api.example.com",
      auth: auth as never,
    });
    await expect(
      client.json("/task/agent/task", { method: "PATCH", body: "{}" }),
    ).rejects.toMatchObject({
      details: {
        category: "conflict",
        status: 409,
        attempts: 1,
        ambiguous_write: false,
        server: body,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("adds auth and json headers for requests with a body", async () => {
    const auth = {
      getAccessToken: vi.fn().mockResolvedValue("token-123"),
      clearToken: vi.fn().mockResolvedValue(undefined),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new KaneoClient({
      baseUrl: "https://api.example.com",
      auth: auth as never,
    });

    await expect(
      client.json("/api/project", {
        method: "POST",
        body: JSON.stringify({ name: "Inbox" }),
      }),
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer token-123");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("clears the cached token and retries once after a 401", async () => {
    const auth = {
      getAccessToken: vi
        .fn()
        .mockResolvedValueOnce("expired-token")
        .mockResolvedValueOnce("fresh-token"),
      clearToken: vi.fn().mockResolvedValue(undefined),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "task-1" }), { status: 200 }),
      );
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new KaneoClient({
      baseUrl: "https://api.example.com",
      auth: auth as never,
    });

    await expect(client.json("/api/task/task-1")).resolves.toEqual({
      id: "task-1",
    });
    expect(auth.clearToken).toHaveBeenCalledTimes(1);
    expect(auth.clearToken).toHaveBeenCalledWith("expired-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces api error messages when a request fails", async () => {
    const auth = {
      getAccessToken: vi.fn().mockResolvedValue("token-123"),
      clearToken: vi.fn().mockResolvedValue(undefined),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "Task not found" }), {
        status: 404,
      }),
    ) as typeof fetch;

    const client = new KaneoClient({
      baseUrl: "https://api.example.com",
      auth: auth as never,
    });

    await expect(client.json("/api/task/missing")).rejects.toThrow(
      "/api/task/missing: Task not found",
    );
  });

  it("retries transient reads but does not replay unsafe writes", async () => {
    const auth = {
      getAccessToken: vi.fn().mockResolvedValue("key"),
      usingApiKey: true,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(new Response('{"ok":true}'));
    globalThis.fetch = fetchMock as typeof fetch;
    const client = new KaneoClient({
      baseUrl: "http://127.0.0.1:1337",
      auth: auth as never,
    });
    expect(await client.json("/api/health")).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock
      .mockClear()
      .mockResolvedValue(new Response("down", { status: 503 }));
    await expect(
      client.json("/api/task/project", { method: "POST", body: "{}" }),
    ).rejects.toThrow("down");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses operation key when replaying a versioned edit", async () => {
    const auth = {
      getAccessToken: vi.fn().mockResolvedValue("key"),
      usingApiKey: true,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("down", { status: 502 }))
      .mockResolvedValueOnce(new Response('{"version":2}'));
    globalThis.fetch = fetchMock as typeof fetch;
    const client = new KaneoClient({
      baseUrl: "http://127.0.0.1:1337",
      auth: auth as never,
    });
    await client.json("/api/task/agent/task1", {
      method: "PATCH",
      body: '{"expectedVersion":1,"title":"New"}',
    });
    const keys = fetchMock.mock.calls.map((call) =>
      new Headers((call[1] as RequestInit).headers).get("Idempotency-Key"),
    );
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });
});
