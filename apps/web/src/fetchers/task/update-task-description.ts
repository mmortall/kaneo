import type Task from "@/types/task";
import patchTask from "./patch-task";

export default function updateTaskDescription(taskId: string, task: Task) {
  return patchTask(taskId, task.version, {
    description: task.description || "",
  });
}
