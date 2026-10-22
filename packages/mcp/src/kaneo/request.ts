import { currentOperation, KaneoRequestError } from "./operation.js";
/** Bound complete JSON responses, including retries and response-body reads. */
export async function requestText(
  url: string,
  init: RequestInit = {},
): Promise<{
  response: Response;
  text: string;
  diagnostics: Record<string, unknown>;
}> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const target = new URL(url);
  const route = target.pathname;
  const trustedHost = process.env.KANEO_CF_ACCESS_HOST
    ? target.hostname === process.env.KANEO_CF_ACCESS_HOST
    : ["admin.polyquantlabs.xyz", "kaneo.polyquantlabs.xyz"].includes(
        target.hostname,
      );
  if (target.protocol === "https:" && trustedHost) {
    if (process.env.CF_ACCESS_CLIENT_ID)
      headers.set("CF-Access-Client-Id", process.env.CF_ACCESS_CLIENT_ID);
    if (process.env.CF_ACCESS_CLIENT_SECRET)
      headers.set(
        "CF-Access-Client-Secret",
        process.env.CF_ACCESS_CLIENT_SECRET,
      );
  }
  if (
    (method === "PATCH" && /\/task\/agent\/[^/]+$/.test(route)) ||
    (method === "POST" && /\/comment\/[^/]+$/.test(route))
  ) {
    if (!headers.has("Idempotency-Key"))
      headers.set("Idempotency-Key", crypto.randomUUID());
  }
  const requestId = crypto.randomUUID();
  headers.set("X-Request-Id", requestId);
  headers.set("User-Agent", "Kaneo-Agent/1.0");
  const safe =
    method === "GET" ||
    headers.has("Idempotency-Key") ||
    (method === "POST" && route.includes("/task/agent/managed/"));
  const started = Date.now();
  const operation = currentOperation();
  const deadline = Math.min(
    started + 20_000,
    operation?.deadline ?? Number.POSITIVE_INFINITY,
  );
  const callerSignal =
    operation?.signal && init.signal
      ? AbortSignal.any([operation.signal, init.signal])
      : (operation?.signal ?? init.signal);
  let dispatched = 0;
  const diagnostics = (category?: string, status?: number) => ({
    category,
    status,
    attempts: dispatched,
    elapsed_ms: Date.now() - started,
    endpoint: new URL(url).origin,
    request_id: requestId,
    ambiguous_write:
      dispatched > 0 &&
      method !== "GET" &&
      [
        "transport",
        "deadline",
        "cancelled",
        "response",
        "upstream",
        "tunnel",
      ].includes(category ?? ""),
  });
  const pause = async (milliseconds: number) => {
    try {
      await wait(milliseconds, callerSignal);
    } catch {
      const category =
        callerSignal?.reason?.name === "TimeoutError"
          ? "deadline"
          : "cancelled";
      throw new KaneoRequestError(
        `Kaneo operation ${category}`,
        diagnostics(category),
      );
    }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    if (callerSignal?.aborted) {
      const category =
        callerSignal.reason?.name === "TimeoutError" ? "deadline" : "cancelled";
      throw new KaneoRequestError(
        `Kaneo operation ${category}`,
        diagnostics(category),
      );
    }
    const timeout = AbortSignal.timeout(Math.min(10_000, remaining));
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeout])
      : timeout;
    try {
      dispatched++;
      const response = await fetch(url, {
        ...init,
        headers,
        signal,
        redirect: "error",
      });
      const text = await response.text();
      if (
        !safe ||
        ![429, 502, 503, 504].includes(response.status) ||
        attempt === 2
      )
        return {
          response,
          text,
          diagnostics: diagnostics(undefined, response.status),
        };
      const retryAfter = response.headers.get("Retry-After")?.trim();
      const retryDate = retryAfter ? Date.parse(retryAfter) : Number.NaN;
      const delay =
        retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Number.isFinite(retryDate)
            ? Math.max(0, retryDate - Date.now())
            : 250 * 2 ** attempt + Math.random() * 200;
      if (delay >= deadline - Date.now())
        return {
          response,
          text,
          diagnostics: diagnostics(undefined, response.status),
        };
      await pause(delay);
    } catch (error) {
      if (error instanceof KaneoRequestError) throw error;
      const code = (error as { cause?: { code?: string } })?.cause?.code;
      const transient =
        (error instanceof DOMException && error.name === "TimeoutError") ||
        [
          "ECONNRESET",
          "ECONNREFUSED",
          "UND_ERR_SOCKET",
          "UND_ERR_CONNECT_TIMEOUT",
        ].includes(code ?? "");
      if (!safe || !transient || attempt === 2 || callerSignal?.aborted) {
        const category = callerSignal?.aborted
          ? callerSignal.reason?.name === "TimeoutError"
            ? "deadline"
            : "cancelled"
          : Date.now() >= deadline
            ? "deadline"
            : code?.includes("CERT") || code === "ERR_TLS_CERT_ALTNAME_INVALID"
              ? "tls"
              : "transport";
        throw new KaneoRequestError(
          `Kaneo request failed: ${error instanceof Error ? error.message : String(error)}`,
          diagnostics(category),
        );
      }
      await pause(
        Math.min(
          250 * 2 ** attempt + Math.random() * 200,
          Math.max(0, deadline - Date.now()),
        ),
      );
    }
  }
  throw new KaneoRequestError(
    "Kaneo operation deadline exceeded",
    diagnostics("deadline"),
  );
}

function wait(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
