import type Task from "@/types/task";
import patchTask from "./patch-task";

export default function updateTaskDueDate(taskId: string, task: Task) {
  return patchTask(taskId, task.version, {
    dueDate: task.dueDate ? new Date(task.dueDate).toISOString() : null,
  });
}
