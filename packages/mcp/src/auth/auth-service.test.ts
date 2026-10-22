import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withOperation } from "../kaneo/operation.js";
import { AuthService } from "./auth-service.js";

const {
  loadCredentialsMock,
  clearCredentialsMock,
  saveCredentialsMock,
  requestDeviceCodeMock,
  pollDeviceAccessTokenMock,
  openMock,
} = vi.hoisted(() => ({
  loadCredentialsMock: vi.fn(),
  clearCredentialsMock: vi.fn(),
  saveCredentialsMock: vi.fn(),
  requestDeviceCodeMock: vi.fn(),
  pollDeviceAccessTokenMock: vi.fn(),
  openMock: vi.fn(),
}));

vi.mock("./token-store.js", () => ({
  loadCredentials: loadCredentialsMock,
  clearCredentials: clearCredentialsMock,
  saveCredentials: saveCredentialsMock,
}));

vi.mock("./device-flow.js", () => ({
  requestDeviceCode: requestDeviceCodeMock,
  pollDeviceAccessToken: pollDeviceAccessTokenMock,
}));

vi.mock("open", () => ({
  default: openMock,
}));

describe("AuthService", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    loadCredentialsMock.mockReset();
    clearCredentialsMock.mockReset();
    saveCredentialsMock.mockReset();
    requestDeviceCodeMock.mockReset();
    pollDeviceAccessTokenMock.mockReset();
    openMock.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("keeps shared token validation alive when one caller cancels", async () => {
    loadCredentialsMock.mockResolvedValue({
      version: 1,
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
      accessToken: "cached",
    });
    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(new Response('{"user":{"id":"user"}}')),
            150,
          );
          init.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(init.signal?.reason);
            },
            { once: true },
          );
        }),
    ) as typeof fetch;
    const service = new AuthService({
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
    });
    const controller = new AbortController();
    const cancelled = withOperation(
      () => service.getAccessToken(),
      controller.signal,
    );
    const survives = withOperation(() => service.getAccessToken());
    const rejection = expect(cancelled).rejects.toMatchObject({
      name: "AbortError",
    });
    setTimeout(() => controller.abort(), 50);
    await rejection;
    await expect(survives).resolves.toBe("cached");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(requestDeviceCodeMock).not.toHaveBeenCalled();
  });

  it("reuses the cached token when validation succeeds", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    loadCredentialsMock.mockResolvedValue({
      version: 1,
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
      accessToken: "cached-token",
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ user: { id: "user-1" } }), {
        status: 200,
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const service = new AuthService({
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
    });

    await expect(service.getAccessToken()).resolves.toBe("cached-token");
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestInit = fetchMock.mock.calls[0]?.[1] as
      | { signal?: AbortSignal }
      | undefined;
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
    expect(clearCredentialsMock).not.toHaveBeenCalled();
    expect(requestDeviceCodeMock).not.toHaveBeenCalled();
  });

  it("keeps shared validation alive after another caller's deadline", async () => {
    loadCredentialsMock.mockResolvedValue({
      version: 1,
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
      accessToken: "cached",
    });
    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(new Response('{"user":{"id":"fixture"}}')),
            150,
          );
          init.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(init.signal?.reason);
            },
            { once: true },
          );
        }),
    ) as typeof fetch;
    const service = new AuthService({
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
    });
    const expired = withOperation(
      () => service.getAccessToken(),
      undefined,
      40,
    );
    const remaining = withOperation(
      () => service.getAccessToken(),
      undefined,
      1000,
    );
    await expect(expired).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(remaining).resolves.toBe("cached");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels abandoned shared validation and permits a new job", async () => {
    loadCredentialsMock.mockResolvedValue({
      version: 1,
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
      accessToken: "cached",
    });
    let sharedSignal: AbortSignal | undefined;
    globalThis.fetch = vi
      .fn()
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            sharedSignal = init.signal ?? undefined;
            init.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          }),
      )
      .mockResolvedValue(
        new Response('{"user":{"id":"fixture"}}'),
      ) as typeof fetch;
    const service = new AuthService({
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
    });
    const controllers = [new AbortController(), new AbortController()];
    const pending = controllers.map((controller) =>
      withOperation(() => service.getAccessToken(), controller.signal).then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
    );
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    // biome-ignore lint/suspicious/useIterableCallbackReturn: abort() result is ignored
    controllers.forEach((controller) => controller.abort());
    const results = await Promise.all(pending);
    expect(results).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({ name: "AbortError" }),
      }),
      expect.objectContaining({
        error: expect.objectContaining({ name: "AbortError" }),
      }),
    ]);
    expect(sharedSignal?.aborted).toBe(true);
    await expect(withOperation(() => service.getAccessToken())).resolves.toBe(
      "cached",
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("invalidates an active stale token job before starting refresh", async () => {
    loadCredentialsMock
      .mockResolvedValueOnce({
        version: 1,
        baseUrl: "https://api.example.com",
        clientId: "kaneo-mcp",
        accessToken: "stale",
      })
      .mockResolvedValue(null);
    let finishValidation!: (response: Response) => void;
    globalThis.fetch = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finishValidation = resolve;
        }),
    ) as typeof fetch;
    requestDeviceCodeMock.mockResolvedValue({
      device_code: "fixture",
      user_code: "fixture",
      verification_uri: "https://verify.example.com",
      interval: 1,
    });
    openMock.mockResolvedValue(undefined);
    pollDeviceAccessTokenMock.mockResolvedValue("fresh");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const service = new AuthService({
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
    });
    const stale = withOperation(() => service.getAccessToken()).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    await service.clearToken();
    const refreshed = withOperation(() => service.getAccessToken());
    finishValidation(new Response('{"user":{"id":"fixture"}}'));
    await expect(refreshed).resolves.toBe("fresh");
    expect(await stale).toMatchObject({ error: { name: "AbortError" } });
    expect(saveCredentialsMock).toHaveBeenCalledTimes(1);
    expect(saveCredentialsMock.mock.calls[0]?.[0]?.accessToken).toBe("fresh");
  });

  it("waits for credential removal before reading cache for refresh", async () => {
    let finishClearing!: () => void;
    clearCredentialsMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishClearing = resolve;
        }),
    );
    loadCredentialsMock.mockResolvedValue(null);
    requestDeviceCodeMock.mockResolvedValue({
      device_code: "fixture",
      user_code: "fixture",
      verification_uri: "https://verify.example.com",
      interval: 1,
    });
    openMock.mockResolvedValue(undefined);
    pollDeviceAccessTokenMock.mockResolvedValue("fresh");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const service = new AuthService({
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
    });
    const clearing = service.clearToken();
    const token = withOperation(() => service.getAccessToken());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const readsBeforeRemoval = loadCredentialsMock.mock.calls.length;
    finishClearing();
    await clearing;
    await expect(token).resolves.toBe("fresh");
    expect(readsBeforeRemoval).toBe(0);
  });

  it("does not cancel replacement login on a late 401 for old token", async () => {
    loadCredentialsMock
      .mockResolvedValueOnce({
        version: 1,
        baseUrl: "https://api.example.com",
        clientId: "kaneo-mcp",
        accessToken: "stale",
      })
      .mockResolvedValue(null);
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('{"user":{"id":"fixture"}}'),
      ) as typeof fetch;
    requestDeviceCodeMock.mockResolvedValue({
      device_code: "fixture",
      user_code: "fixture",
      verification_uri: "https://verify.example.com",
      interval: 1,
    });
    openMock.mockResolvedValue(undefined);
    let finishApproval!: (token: string) => void;
    pollDeviceAccessTokenMock.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finishApproval = resolve;
        }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const service = new AuthService({
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
    });
    await expect(withOperation(() => service.getAccessToken())).resolves.toBe(
      "stale",
    );
    await service.clearToken("stale");
    const replacement = withOperation(() => service.getAccessToken());
    await vi.waitFor(() =>
      expect(pollDeviceAccessTokenMock).toHaveBeenCalledTimes(1),
    );
    await service.clearToken("stale");
    finishApproval("fresh");
    await expect(replacement).resolves.toBe("fresh");
    expect(clearCredentialsMock).toHaveBeenCalledTimes(1);
  });

  it("shares pending credential removal when active invalid-token login is cleared", async () => {
    loadCredentialsMock
      .mockResolvedValueOnce({
        version: 1,
        baseUrl: "https://api.example.com",
        clientId: "kaneo-mcp",
        accessToken: "stale",
      })
      .mockResolvedValue(null);
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("unauthorized", { status: 401 }),
      ) as typeof fetch;
    let finishRemoval!: () => void;
    clearCredentialsMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRemoval = resolve;
        }),
    );
    requestDeviceCodeMock.mockResolvedValue({
      device_code: "fixture",
      user_code: "fixture",
      verification_uri: "https://verify.example.com",
      interval: 1,
    });
    openMock.mockResolvedValue(undefined);
    pollDeviceAccessTokenMock.mockResolvedValue("fresh");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const service = new AuthService({
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
    });
    const invalid = withOperation(() => service.getAccessToken()).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await vi.waitFor(() =>
      expect(clearCredentialsMock).toHaveBeenCalledTimes(1),
    );
    const clearing = service.clearToken();
    const replacement = withOperation(() => service.getAccessToken());
    expect(clearCredentialsMock).toHaveBeenCalledTimes(1);
    finishRemoval();
    await clearing;
    await expect(replacement).resolves.toBe("fresh");
    expect(await invalid).toMatchObject({ error: { name: "AbortError" } });
    expect(saveCredentialsMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the cached token when validation cannot confirm validity", async () => {
    loadCredentialsMock.mockResolvedValue({
      version: 1,
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
      accessToken: "cached-token",
    });
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(
        new Error("temporary network failure"),
      ) as typeof fetch;

    const service = new AuthService({
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
    });

    await expect(service.getAccessToken()).resolves.toBe("cached-token");
    expect(clearCredentialsMock).not.toHaveBeenCalled();
    expect(requestDeviceCodeMock).not.toHaveBeenCalled();
  });

  it("clears the cached token and starts device auth after a 401", async () => {
    loadCredentialsMock.mockResolvedValue({
      version: 1,
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
      accessToken: "expired-token",
    });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "Unauthorized" }), {
        status: 401,
      }),
    ) as typeof fetch;
    requestDeviceCodeMock.mockResolvedValue({
      device_code: "device-code",
      user_code: "ABCD-EFGH",
      verification_uri: "https://verify.example.com",
      interval: 5,
    });
    pollDeviceAccessTokenMock.mockResolvedValue("fresh-token");

    const service = new AuthService({
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
    });

    await expect(service.getAccessToken()).resolves.toBe("fresh-token");
    expect(clearCredentialsMock).toHaveBeenCalledTimes(1);
    expect(requestDeviceCodeMock).toHaveBeenCalledWith(
      "https://api.example.com",
      "kaneo-mcp",
    );
    expect(saveCredentialsMock).toHaveBeenCalledWith({
      version: 1,
      baseUrl: "https://api.example.com",
      clientId: "kaneo-mcp",
      accessToken: "fresh-token",
    });
  });
});
