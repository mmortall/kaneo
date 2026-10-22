import open from "open";
import {
  awaitOperation,
  currentOperation,
  withOperation,
  withoutOperation,
} from "../kaneo/operation.js";
import { requestText } from "../kaneo/request.js";
import { pollDeviceAccessToken, requestDeviceCode } from "./device-flow.js";
import {
  clearCredentials,
  loadCredentials,
  type StoredCredentials,
  saveCredentials,
} from "./token-store.js";

export type AuthServiceOptions = {
  baseUrl: string;
  clientId: string;
  apiKey?: string;
};

type TokenValidationResult = "valid" | "invalid" | "unknown";
type TokenJob = {
  promise: Promise<string>;
  controller: AbortController;
  waiters: number;
  generation: number;
};

export class AuthService {
  readonly baseUrl: string;
  readonly clientId: string;
  private readonly apiKey?: string;
  private activeTokenJob?: TokenJob;
  private clearingToken?: Promise<void>;
  private tokenGeneration = 0;
  private issuedTokens = new Map<string, number>();

  private async awaitTokenJob(job: TokenJob): Promise<string> {
    job.waiters++;
    try {
      const token = await awaitOperation(job.promise);
      this.issuedTokens.set(token, job.generation);
      if (this.issuedTokens.size > 32)
        this.issuedTokens.delete(this.issuedTokens.keys().next().value!);
      return token;
    } finally {
      job.waiters--;
      if (job.waiters === 0) {
        job.controller.abort();
        if (this.activeTokenJob === job) this.activeTokenJob = undefined;
      }
    }
  }

  constructor(options: AuthServiceOptions) {
    this.baseUrl = options.baseUrl;
    this.clientId = options.clientId;
    this.apiKey = options.apiKey;
  }

  /**
   * True when a pre-created Kaneo API key is used instead of the interactive
   * device flow. Callers use this to avoid clearing/retrying auth on a 401.
   */
  get usingApiKey(): boolean {
    return Boolean(this.apiKey);
  }

  async clearToken(rejectedToken?: string): Promise<void> {
    // Nothing to clear for API-key auth; the key is static config.
    if (this.apiKey) return;
    // Late 401 for an older generation must not cancel replacement login.
    if (
      rejectedToken !== undefined &&
      this.issuedTokens.get(rejectedToken) !== this.tokenGeneration
    ) {
      if (this.clearingToken) await this.clearingToken;
      return;
    }
    if (this.clearingToken && !this.activeTokenJob) return this.clearingToken;
    this.tokenGeneration++;
    const previous = this.activeTokenJob;
    this.activeTokenJob = undefined;
    previous?.controller.abort(
      new DOMException("Cached authentication invalidated", "AbortError"),
    );
    await this.removeStoredCredentials();
  }

  private async removeStoredCredentials(): Promise<void> {
    if (this.clearingToken) return this.clearingToken;
    const clearing = clearCredentials();
    this.clearingToken = clearing;
    try {
      await clearing;
    } finally {
      if (this.clearingToken === clearing) this.clearingToken = undefined;
    }
  }

  private async validateAccessToken(
    token: string,
  ): Promise<TokenValidationResult> {
    try {
      const { response: res, text } = await requestText(
        `${this.baseUrl}/api/auth/get-session`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (res.status === 401) {
        return "invalid";
      }
      if (!res.ok) {
        return "unknown";
      }
      const data = JSON.parse(text || "null") as {
        user?: { id?: string };
      } | null;
      return data?.user?.id ? "valid" : "unknown";
    } catch {
      currentOperation()?.signal.throwIfAborted();
      return "unknown";
    }
  }

  private log(msg: string): void {
    console.error(`[kaneo-mcp] ${msg}`);
  }

  /**
   * Returns a valid access token, running the device authorization flow if needed.
   */
  async getAccessToken(): Promise<string> {
    // Non-interactive auth: a pre-created Kaneo API key (KANEO_API_KEY) is sent
    // as a Bearer token, which the REST API already accepts. This skips the
    // device flow so the MCP server works in headless/Docker environments.
    if (this.apiKey) {
      return this.apiKey;
    }

    if (this.clearingToken) await awaitOperation(this.clearingToken);

    if (this.activeTokenJob) {
      return await this.awaitTokenJob(this.activeTokenJob);
    }

    const job: TokenJob = {
      promise: Promise.resolve(""),
      controller: new AbortController(),
      waiters: 0,
      generation: this.tokenGeneration,
    };
    this.activeTokenJob = job;
    // Each caller keeps own budget. Cancel shared login only after last waiter leaves.
    job.promise = withoutOperation(() =>
      withOperation(
        async () => {
          const cached = await loadCredentials();
          currentOperation()?.signal.throwIfAborted();
          if (
            cached &&
            cached.baseUrl === this.baseUrl &&
            cached.clientId === this.clientId &&
            cached.accessToken
          ) {
            const validation = await this.validateAccessToken(
              cached.accessToken,
            );
            currentOperation()?.signal.throwIfAborted();
            // Fail-open for "unknown": validateAccessToken returns "unknown" on transient HTTP/network
            // errors or ambiguous responses. Treating "unknown" like "valid" avoids clearToken() and a full
            // device re-auth so flaky connectivity does not wipe cached.accessToken; only "invalid" forces
            // a fresh login. Tests should cover both unknown and invalid paths.
            if (validation === "valid" || validation === "unknown") {
              return cached.accessToken;
            }
            // This job owns invalid cached token; keep its replacement login alive.
            await this.removeStoredCredentials();
          }

          const code = await requestDeviceCode(this.baseUrl, this.clientId);
          currentOperation()?.signal.throwIfAborted();
          const verifyUrl =
            code.verification_uri_complete || code.verification_uri;
          this.log(
            `Open ${verifyUrl} and approve this device. User code: ${code.user_code}`,
          );

          try {
            await awaitOperation(open(verifyUrl));
          } catch {
            currentOperation()?.signal.throwIfAborted();
            this.log(
              "Could not open a browser automatically; use the URL above.",
            );
          }

          const accessToken = await pollDeviceAccessToken(
            this.baseUrl,
            this.clientId,
            code.device_code,
            code.interval,
            { log: (m) => this.log(m) },
          );

          const toStore: StoredCredentials = {
            version: 1,
            baseUrl: this.baseUrl,
            clientId: this.clientId,
            accessToken,
          };
          currentOperation()?.signal.throwIfAborted();
          await saveCredentials(toStore);
          return accessToken;
        },
        job.controller.signal,
        30 * 60 * 1000,
      ),
    );
    return this.awaitTokenJob(job);
  }
}
