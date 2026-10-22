import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { columnTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import {
  assertTaskWorkflowPolicy,
  isAiTaskCaller,
  resolveTaskWorkflowFields,
} from "../task-workflow-policy";
import { assertValidTaskStatus } from "../validate-task-fields";

async function updateTaskStatus({
  id,
  status,
  currentUserId,
  caller,
  goal,
  acceptanceCriteria,
  blockedReason,
  unblockPolicy,
  completionSummary,
  unblockNote,
}: {
  id: string;
  status: string;
  currentUserId: string;
  caller?: string;
  goal?: string;
  acceptanceCriteria?: string;
  blockedReason?: string;
  unblockPolicy?: string;
  completionSummary?: string;
  unblockNote?: string;
}) {
  const existingTask = await db.query.taskTable.findFirst({
    where: eq(taskTable.id, id),
  });

  if (!existingTask) {
    throw new HTTPException(404, {
      message: "Task not found",
    });
  }

  await assertValidTaskStatus(status, existingTask.projectId);

  const column = await db.query.columnTable.findFirst({
    where: and(
      eq(columnTable.projectId, existingTask.projectId),
      eq(columnTable.slug, status),
    ),
  });

  const workflowFields = resolveTaskWorkflowFields(existingTask, status, {
    goal,
    acceptanceCriteria,
    blockedReason,
    unblockPolicy,
    completionSummary,
  });
  assertTaskWorkflowPolicy({
    isAiCaller: isAiTaskCaller(caller),
    existing: existingTask,
    nextStatus: status,
    isFinalStatus: status === "done" || column?.isFinal === true,
    fields: {
      ...workflowFields,
      ...(existingTask.status !== "blocked" && status === "blocked"
        ? { blockedReason, unblockPolicy }
        : {}),
    },
    unblockNote,
  });

  const [updatedTask] = await db
    .update(taskTable)
    .set({ status, columnId: column?.id ?? null, ...workflowFields })
    .where(
      and(eq(taskTable.id, id), eq(taskTable.version, existingTask.version)),
    )
    .returning();

  if (!updatedTask) {
    throw new HTTPException(409, {
      message: "Task changed during status validation; reload before retrying",
    });
  }

  await publishEvent("task.status_changed", {
    taskId: updatedTask.id,
    projectId: updatedTask.projectId,
    userId: currentUserId,
    oldStatus: existingTask.status,
    newStatus: status,
    title: updatedTask.title,
    assigneeId: updatedTask.userId,
    type: "status_changed",
  });

  await publishEvent("task-relation.refresh", {
    projectId: updatedTask.projectId,
    userId: currentUserId,
  });

  return updatedTask;
}

export default updateTaskStatus;
