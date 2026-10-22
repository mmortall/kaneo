import type Task from "@/types/task";
import { deleteOperation } from "./delete-operation";

export type DeleteTaskRequest = Pick<Task, "id" | "version" | "projectId">;
export default function deleteTask(task: DeleteTaskRequest) {
  if (!Number.isSafeInteger(task.version) || (task.version ?? 0) < 1)
    throw new Error(
      "Reload task before deleting; task version is missing or invalid",
    );
  return deleteOperation(task.projectId, [
    { id: task.id, version: task.version! },
  ]);
}
