import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const operations = new AsyncLocalStorage<{
  deadline: number;
  signal: AbortSignal;
}>();

export function currentOperation() {
  return operations.getStore();
}

export function withoutOperation<T>(fn: () => T): T {
  return operations.exit(fn);
}

export function operationSignal(milliseconds = 10_000): AbortSignal {
  const operation = currentOperation();
  operation?.signal.throwIfAborted();
  const remaining = Math.min(
    milliseconds,
    (operation?.deadline ?? Number.POSITIVE_INFINITY) - Date.now(),
  );
  if (remaining <= 0)
    throw new DOMException("Kaneo operation deadline exceeded", "TimeoutError");
  const timeout = AbortSignal.timeout(Math.ceil(remaining));
  return operation ? AbortSignal.any([operation.signal, timeout]) : timeout;
}

export async function awaitOperation<T>(promise: Promise<T>): Promise<T> {
  const signal = currentOperation()?.signal;
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function withOperation<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
  milliseconds = 20_000,
): Promise<T> {
  if (currentOperation()) return fn();
  const timeout = AbortSignal.timeout(milliseconds);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return operations.run(
    { deadline: Date.now() + milliseconds, signal: combined },
    async () => {
      combined.throwIfAborted();
      return fn();
    },
  );
}

/** SDK cancellation and one budget cover every REST call in tool callback. */
export function boundedRegistrar(server: McpServer): McpServer["registerTool"] {
  return (name, config, callback) => {
    const wrapped = ((...args: unknown[]) =>
      withOperation(
        () => Reflect.apply(callback, undefined, args),
        (args.at(-1) as { signal?: AbortSignal } | undefined)?.signal,
      )) as typeof callback;
    return server.registerTool(name, config, wrapped);
  };
}

export class KaneoRequestError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "KaneoRequestError";
  }
}

export function httpCategory(status: number, body: unknown): string {
  const error =
    body && typeof body === "object"
      ? (body as { error?: string }).error
      : undefined;
  if (error === "TASK_WORKFLOW_POLICY") return "policy";
  if (status === 409) return "conflict";
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "throttled";
  if (status === 530) return "tunnel";
  return status >= 500 ? "upstream" : "validation";
}
