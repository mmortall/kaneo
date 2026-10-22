import { client } from "@kaneo/libs";
import type { InferRequestType } from "hono/client";
import type Task from "@/types/task";

type UpdateTaskPriority = InferRequestType<
  (typeof client)["task"][":id"]["$put"]
>["json"]["priority"];
type UpdateTaskUnblockPolicy = InferRequestType<
  (typeof client)["task"][":id"]["$put"]
>["json"]["unblockPolicy"];

export class TaskConflictError extends Error {}

async function updateTask(taskId: string, task: Task) {
  if (task.isSummary)
    throw new Error(
      "Open task details before replacing task; summary fields are incomplete",
    );
  if (task.version === undefined)
    throw new Error("Reload task before editing; task version is missing");
  const workItemType =
    task.workItemType === "epic" || task.workItemType === "sub_epic"
      ? task.workItemType
      : "task";
  const response = await client.task[":id"].$put({
    param: { id: taskId },
    json: {
      expectedVersion: task.version,
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
    if (response.status === 409)
      throw new TaskConflictError(
        "Task changed. Reloading latest data; review changes before retrying.",
      );
    throw new Error(error);
  }

  const data = await response.json();

  return data;
}

export default updateTask;
