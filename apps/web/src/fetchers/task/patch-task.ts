import { client } from "@kaneo/libs";
import type { InferRequestType } from "hono/client";
import { TaskConflictError } from "./update-task";

type Patch = InferRequestType<
  (typeof client)["task"]["agent"][":id"]["$patch"]
>["json"];
export type TaskPatchFields = Omit<Patch, "expectedVersion">;

export default async function patchTask(
  taskId: string,
  version: number | undefined,
  fields: Omit<Patch, "expectedVersion">,
) {
  if (!Number.isInteger(version) || (version ?? 0) < 1) {
    throw new Error(
      "Reload task before editing; task version is missing or invalid",
    );
  }
  const response = await client.task.agent[":id"].$patch({
    param: { id: taskId },
    json: { ...fields, expectedVersion: version as number },
  });
  if (!response.ok) {
    if (response.status === 409) {
      throw new TaskConflictError(
        "Task changed. Reloading latest data; review changes before retrying.",
      );
    }
    throw new Error(await response.text());
  }
  return response.json();
}
