import { HTTPException } from "hono/http-exception";
import bulkUpdateTasks from "./bulk-update-tasks";
import getTask from "./get-task";

/** Delete one reviewed revision through the atomic selected-delete contract. */
async function deleteTask(
  taskId: string,
  currentUserId: string,
  expectedVersion: number,
  workspaceId?: string,
) {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1)
    throw new HTTPException(400, {
      message: "Expected task version is required for deletion",
    });
  const task = await getTask(taskId);
  await bulkUpdateTasks({
    taskIds: [taskId],
    operation: "delete",
    userId: currentUserId,
    expectedVersions: [{ id: taskId, version: expectedVersion }],
    workspaceId,
  });
  return task;
}
export default deleteTask;
