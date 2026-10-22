import type Task from "@/types/task";
import patchTask from "./patch-task";

export default function updateTaskAssignee(
  taskId: string,
  task: Pick<Task, "userId" | "version">,
) {
  return patchTask(taskId, task.version, { userId: task.userId || "" });
}
