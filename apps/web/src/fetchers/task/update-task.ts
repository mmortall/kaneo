import { client } from "@kaneo/libs";
import type { InferRequestType } from "hono/client";
import type Task from "@/types/task";

type UpdateTaskPriority = InferRequestType<
  (typeof client)["task"][":id"]["$put"]
>["json"]["priority"];
type UpdateTaskUnblockPolicy = InferRequestType<
  (typeof client)["task"][":id"]["$put"]
>["json"]["unblockPolicy"];

async function updateTask(taskId: string, task: Task) {
  const workItemType =
    task.workItemType === "epic" || task.workItemType === "sub_epic"
      ? task.workItemType
      : "task";
  const response = await client.task[":id"].$put({
    param: { id: taskId },
    json: {
      userId: task.userId || "",
      title: task.title,
      description: task.description || "",
      status: task.status,
      priority: (task.priority || "") as UpdateTaskPriority,
      startDate: task.startDate?.toString(),
      dueDate: task.dueDate?.toString(),
      position: task.position ?? 0,
      projectId: task.projectId,
      workItemType,
      taskCategory: task.taskCategory ?? "live_implementation",
      strategyHorizons: task.strategyHorizons ?? [],
      goal: task.goal || undefined,
      acceptanceCriteria: task.acceptanceCriteria || undefined,
      blockedReason: task.blockedReason || undefined,
      unblockPolicy: (task.unblockPolicy ||
        undefined) as UpdateTaskUnblockPolicy,
      completionSummary: task.completionSummary || undefined,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  const data = await response.json();

  return data;
}

export default updateTask;
