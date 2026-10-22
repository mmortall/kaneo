import type Task from "@/types/task";
import patchTask from "./patch-task";

export default function updateTaskStatus(
  taskId: string,
  task: Pick<Task, "status" | "version" | "completionSummary">,
) {
  return patchTask(taskId, task.version, {
    status: task.status || "",
    ...(task.completionSummary
      ? { completionSummary: task.completionSummary }
      : {}),
  });
}
