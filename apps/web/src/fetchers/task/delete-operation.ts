import { client } from "@kaneo/libs";
import { TaskConflictError } from "./update-task";

type Selection = { id: string; version: number }[];
export type DeleteReceipt = {
  operationId: string;
  projectId: string;
  success: true;
  deletedCount: number;
  taskIds: string[];
};
const prefix = "kaneo-delete-operation:";
export const deletionStorageEvent = "kaneo-deletion-operations-changed";
export type PendingDeletion = {
  projectId: string;
  tasks: Selection;
  key: string;
  storageKey: string;
};
function notifyStorage() {
  window.dispatchEvent(new Event(deletionStorageEvent));
}
function forget(storageKey: string) {
  sessionStorage.removeItem(storageKey);
  notifyStorage();
}

/** Inspect only bounded, valid saved selections belonging to current project. */
export function pendingDeletions(projectId: string): PendingDeletion[] {
  const result: PendingDeletion[] = [];
  for (let index = 0; index < sessionStorage.length; index++) {
    const storageKey = sessionStorage.key(index);
    if (!storageKey?.startsWith(prefix)) continue;
    try {
      const [savedProject, tasks] = JSON.parse(storageKey.slice(prefix.length));
      const key = sessionStorage.getItem(storageKey);
      if (
        savedProject !== projectId ||
        !key ||
        !/^[\w:.-]{1,128}$/.test(key) ||
        !Array.isArray(tasks) ||
        !tasks.length ||
        tasks.length > 100 ||
        new Set(tasks.map((task) => task?.id)).size !== tasks.length ||
        tasks.some(
          (task) =>
            typeof task?.id !== "string" ||
            !task.id ||
            !Number.isSafeInteger(task.version) ||
            task.version < 1,
        )
      )
        continue;
      result.push({ projectId, tasks, key, storageKey });
      if (result.length === 20) break;
    } catch {
      /* Corrupt entries are not eligible for replay or removal. */
    }
  }
  return result;
}

/** Receipt lookup never resubmits a mutation, even when receipt is absent. */
export async function checkPendingDeletion(
  pending: PendingDeletion,
  signal: AbortSignal,
): Promise<DeleteReceipt | null> {
  const response = await client.task.agent.delete[":projectId"].receipt.$get(
    { param: { projectId: pending.projectId }, query: { key: pending.key } },
    { init: { signal } },
  );
  if (!response.ok)
    throw new Error("Could not check deletion result. Try again later.");
  const body = await response.json();
  if (body.receipt === null) return null;
  const result = receipt(body.receipt, pending.projectId, pending.tasks);
  if (sessionStorage.getItem(pending.storageKey) === pending.key)
    forget(pending.storageKey);
  return result;
}
const uncertain =
  "Delete result is uncertain. Retry the same reviewed selection to check saved result.";

function receipt(
  value: unknown,
  projectId: string,
  tasks: Selection,
): DeleteReceipt {
  const result = value as DeleteReceipt | null;
  if (
    !result ||
    !/^[a-f0-9]{64}$/.test(result.operationId) ||
    result.projectId !== projectId ||
    result.success !== true ||
    result.deletedCount !== tasks.length ||
    !Array.isArray(result.taskIds) ||
    JSON.stringify([...result.taskIds].sort()) !==
      JSON.stringify(tasks.map((task) => task.id).sort())
  )
    throw new Error("Invalid deletion receipt returned by server");
  return result;
}

/** Keep operation key across reloads; retry only original reviewed selection. */
export async function deleteOperation(
  projectId: string,
  selection: Selection,
): Promise<DeleteReceipt> {
  if (
    !projectId ||
    !selection.length ||
    selection.length > 100 ||
    new Set(selection.map((task) => task.id)).size !== selection.length ||
    selection.some(
      (task) =>
        !task.id || !Number.isSafeInteger(task.version) || task.version < 1,
    )
  )
    throw new Error(
      "Select up to 100 loaded tasks with valid versions. Reload before retrying.",
    );
  const tasks = [...selection].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const storageKey = prefix + JSON.stringify([projectId, tasks]);
  const previous = sessionStorage.getItem(storageKey);
  if (previous && !/^[\w:.-]{1,128}$/.test(previous))
    throw new Error(
      "Invalid saved deletion operation. Reload before deleting.",
    );
  const key = previous ?? crypto.randomUUID();
  if (
    !previous &&
    Object.keys(sessionStorage).filter((name) => name.startsWith(prefix))
      .length >= 20
  )
    throw new Error(
      "Check pending deletion results before starting another deletion.",
    );
  // Reserve key before first await so concurrent confirmations share operation.
  sessionStorage.setItem(storageKey, key);
  notifyStorage();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  const init = { signal: controller.signal };
  const route = client.task.agent.delete[":projectId"];
  const recover = async () => {
    const response = await route.receipt.$get(
      { param: { projectId }, query: { key } },
      { init },
    );
    if (!response.ok) throw new Error(uncertain);
    const body = await response.json();
    if (body.receipt === null) return null;
    return receipt(body.receipt, projectId, tasks);
  };
  try {
    const capability = await client.task.agent.capabilities.$get({}, { init });
    if (
      !capability.ok ||
      (await capability.json()).deleteOperationReceipts !== true
    ) {
      if (!previous) forget(storageKey);
      throw new Error(
        "Server does not support deletion receipts. Reload after upgrading Kaneo.",
      );
    }
    if (previous) {
      const saved = await recover();
      if (saved) {
        forget(storageKey);
        return saved;
      }
    }
    let response: Response;
    try {
      response = await route.$post(
        { param: { projectId }, json: { key, tasks } },
        { init },
      );
    } catch {
      try {
        const saved = await recover();
        if (saved) {
          forget(storageKey);
          return saved;
        }
      } catch {
        /* Preserve original key when recovery is unavailable. */
      }
      throw new Error(uncertain);
    }
    if (!response.ok) {
      if (response.status === 409) {
        forget(storageKey);
        throw new TaskConflictError(
          "Selected tasks changed. Reload and review latest versions before deleting.",
        );
      }
      if (response.status >= 500) throw new Error(uncertain);
      forget(storageKey);
      throw new Error(await response.text());
    }
    const result = receipt(await response.json(), projectId, tasks);
    forget(storageKey);
    return result;
  } finally {
    clearTimeout(timer);
  }
}
