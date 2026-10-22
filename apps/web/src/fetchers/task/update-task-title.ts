import type Task from "@/types/task";
import patchTask from "./patch-task";

export default function updateTaskTitle(taskId: string, task: Task) {
  return patchTask(taskId, task.version, { title: task.title || "" });
}
