import { client } from "@kaneo/libs";
import { TaskConflictError } from "./update-task";

type BulkOperationType =
  | "updateStatus"
  | "updatePriority"
  | "updateAssignee"
  | "delete"
  | "addLabel"
  | "removeLabel"
  | "updateDueDate";

async function bulkOperation({
  taskIds,
  operation,
  value,
  expectedVersions,
}: {
  taskIds: string[];
  operation: BulkOperationType;
  value?: string | null;
  expectedVersions?: { id: string; version: number }[];
}) {
  if (operation === "delete")
    throw new Error(
      "Use project-scoped deletion with saved operation receipt.",
    );
  const labels = operation === "addLabel" || operation === "removeLabel";
  const guarded =
    labels ||
    [
      "updateStatus",
      "updatePriority",
      "updateAssignee",
      "updateDueDate",
    ].includes(operation);
  if (guarded) {
    const versions = new Map(
      expectedVersions?.map((task) => [task.id, task.version]),
    );
    if (
      !expectedVersions ||
      taskIds.length === 0 ||
      taskIds.length > 100 ||
      new Set(taskIds).size !== taskIds.length ||
      versions.size !== expectedVersions.length ||
      versions.size !== taskIds.length ||
      taskIds.some(
        (id) =>
          !Number.isInteger(versions.get(id)) || (versions.get(id) ?? 0) < 1,
      )
    )
      throw new Error(
        "Select up to 100 loaded tasks with valid versions. Reload before retrying.",
      );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const init = { signal: controller.signal };
    if (guarded) {
      const capability = await client.task.agent.capabilities.$get(
        {},
        { init },
      );
      if (
        !capability.ok ||
        (await capability.json())[
          labels ? "versionedBulkTaskLabels" : "versionedBulkTaskFields"
        ] !== true
      )
        throw new Error(
          "Server does not support versioned bulk updates. Reload after upgrading Kaneo.",
        );
    }
    const response = await client.task.bulk
      .$patch(
        { json: { taskIds, operation, value, expectedVersions } },
        { init },
      )
      .catch(() => {
        throw new Error(
          "Bulk update response was lost or timed out. Changes may have committed. Reload and review before retrying.",
        );
      });
    if (!response.ok) {
      if (response.status === 409)
        throw new TaskConflictError(
          "Selected tasks changed. Reloading latest data; review selection before retrying.",
        );
      throw new Error(await response.text());
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

export default bulkOperation;
