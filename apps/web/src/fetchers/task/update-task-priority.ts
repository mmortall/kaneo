import type Task from "@/types/task";
import patchTask from "./patch-task";

export default function updateTaskPriority(taskId: string, task: Task) {
  return patchTask(taskId, task.version, {
    priority: (task.priority || "no-priority") as NonNullable<
      Parameters<typeof patchTask>[2]["priority"]
    >,
  });
}
