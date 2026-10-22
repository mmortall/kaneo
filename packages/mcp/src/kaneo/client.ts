import type { AuthService } from "../auth/auth-service.js";
import {
  awaitOperation,
  httpCategory,
  KaneoRequestError,
  withOperation,
} from "./operation.js";
import { requestText } from "./request.js";

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export class KaneoClient {
  readonly baseUrl: string;
  private readonly auth: AuthService;
  private relationIdempotency?: Promise<boolean>;

  private supportsRelationIdempotency(): Promise<boolean> {
    this.relationIdempotency ??= this.json<{ relationIdempotency?: boolean }>(
      "/api/task/agent/capabilities",
    )
      .then((capabilities) => capabilities.relationIdempotency === true)
      .catch((error) => {
        if (error instanceof KaneoRequestError && error.details.status === 404)
          return false;
        this.relationIdempotency = undefined;
        throw error;
      });
    return this.relationIdempotency;
  }

  constructor(options: { baseUrl: string; auth: AuthService }) {
    this.baseUrl = options.baseUrl;
    this.auth = options.auth;
  }

  private async authorizedFetch(
    path: string,
    init?: RequestInit,
    didRetry = false,
  ): Promise<{
    response: Response;
    text: string;
    diagnostics: Record<string, unknown>;
  }> {
    const token = await awaitOperation(this.auth.getAccessToken());
    const headers = new Headers(init?.headers);
    if (
      init?.method?.toUpperCase() === "POST" &&
      /\/task-relation\/?$/.test(path) &&
      !headers.has("Idempotency-Key") &&
      (await this.supportsRelationIdempotency())
    ) {
      headers.set("Idempotency-Key", crypto.randomUUID());
    }
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("x-kaneo-caller", "ai");
    if (init?.body != null && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const result = await requestText(url, { ...init, headers });
    const res = result.response;

    // With a static API key there is nothing to refresh, so surface the 401
    // instead of looping back into the interactive device flow.
    if (res.status === 401 && !didRetry && !this.auth.usingApiKey) {
      await awaitOperation(this.auth.clearToken(token));
      return this.authorizedFetch(path, init, true);
    }

    return result;
  }

  async json<T = Json>(path: string, init?: RequestInit): Promise<T> {
    try {
      return await withOperation(
        () => this.jsonInOperation<T>(path, init),
        init?.signal ?? undefined,
      );
    } catch (error) {
      if (
        error instanceof DOMException &&
        ["AbortError", "TimeoutError"].includes(error.name)
      ) {
        throw new KaneoRequestError(
          `Kaneo authentication ${error.name === "TimeoutError" ? "deadline exceeded" : "cancelled"}`,
          {
            category: error.name === "TimeoutError" ? "deadline" : "cancelled",
            stage: "authentication",
            endpoint: new URL(this.baseUrl).origin,
            ambiguous_write: false,
          },
        );
      }
      throw error;
    }
  }

  private async jsonInOperation<T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    const {
      response: res,
      text,
      diagnostics,
    } = await this.authorizedFetch(path, init);
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        if (res.ok)
          throw new KaneoRequestError(`${path}: Invalid JSON response`, {
            ...diagnostics,
            category: "response",
            ambiguous_write: (init?.method ?? "GET").toUpperCase() !== "GET",
          });
        body = text;
      }
    }
    if (!res.ok) {
      let detail: string;
      if (
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        (body as { error?: unknown }).error === "TASK_WORKFLOW_POLICY"
      ) {
        detail = JSON.stringify(body);
      } else if (
        typeof body === "object" &&
        body !== null &&
        "message" in body &&
        typeof (body as { message: unknown }).message === "string"
      ) {
        detail = (body as { message: string }).message;
      } else if (typeof body === "string" && body.length > 0) {
        detail = body.length > 500 ? `${body.slice(0, 500)}…` : body;
      } else {
        detail = `HTTP ${res.status}`;
      }
      const category = httpCategory(res.status, body);
      throw new KaneoRequestError(`${path}: ${detail}`, {
        ...diagnostics,
        category,
        ambiguous_write:
          (init?.method ?? "GET").toUpperCase() !== "GET" &&
          ["upstream", "tunnel"].includes(category),
        server: typeof body === "object" ? body : undefined,
      });
    }
    return body as T;
  }
}
