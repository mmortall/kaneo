import { client } from "@kaneo/libs";
import { TaskConflictError } from "./update-task";

async function moveTask({
  taskId,
  destinationProjectId,
  destinationStatus,
  expectedVersion,
}: {
  taskId: string;
  destinationProjectId: string;
  destinationStatus?: string;
  expectedVersion?: number;
}) {
  if (!Number.isInteger(expectedVersion) || (expectedVersion ?? 0) < 1) {
    throw new Error(
      "Reload task before moving; task version is missing or invalid",
    );
  }
  const capabilitiesResponse = await client.task.agent.capabilities.$get();
  if (!capabilitiesResponse.ok)
    throw new Error(
      "Could not verify task move support; reload before retrying",
    );
  const capabilities = await capabilitiesResponse.json();
  if (!capabilities.versionedTaskMoves)
    throw new Error("Upgrade Kaneo API to support versioned task moves");
  const response = await client.task.move[":id"].$put({
    param: { id: taskId },
    json: {
      destinationProjectId,
      destinationStatus,
      expectedVersion,
    },
  });

  if (!response.ok) {
    if (response.status === 409)
      throw new TaskConflictError(
        "Task changed. Reloading latest data; review changes before retrying.",
      );
    let message: string;
    try {
      const json = await response.json();
      message =
        (json as { message?: string; error?: string }).message ||
        (json as { error?: string }).error ||
        JSON.stringify(json);
    } catch {
      message =
        (await response.text().catch(() => "")) ||
        `API error ${response.status}`;
    }
    throw new Error(message);
  }

  return response.json();
}

export default moveTask;
