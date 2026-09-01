import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { columnTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { deleteOrphanedAssets } from "../../storage/cleanup-assets";
import {
  assertWorkItemTypeChangeAllowed,
  type WorkItemType,
} from "../../task-relation/work-item-hierarchy";
import type { TaskCategory } from "../task-category";
import { normalizeTaskHorizons, type TaskHorizon } from "../task-horizon";
import {
  assertTaskWorkflowPolicy,
  isAiTaskCaller,
  resolveTaskWorkflowFields,
} from "../task-workflow-policy";
import { assertValidTaskStatus } from "../validate-task-fields";

async function updateTask(
  id: string,
  title: string,
  status: string,
  startDate: Date | undefined,
  dueDate: Date | undefined,
  projectId: string,
  description: string,
  priority: string,
  position: number,
  userId?: string,
  workItemType?: WorkItemType,
  taskCategory?: TaskCategory,
  strategyHorizons?: TaskHorizon[],
  currentUserId?: string,
  workflowFields: {
    goal?: string;
    acceptanceCriteria?: string;
    blockedReason?: string;
    unblockPolicy?: string;
    completionSummary?: string;
    unblockNote?: string;
  } = {},
  caller?: string,
) {
  const [existingTask] = await db
    .select({
      id: taskTable.id,
      description: taskTable.description,
      status: taskTable.status,
      projectId: taskTable.projectId,
      workItemType: taskTable.workItemType,
      taskCategory: taskTable.taskCategory,
      strategyHorizons: taskTable.strategyHorizons,
      goal: taskTable.goal,
      acceptanceCriteria: taskTable.acceptanceCriteria,
      blockedReason: taskTable.blockedReason,
      unblockPolicy: taskTable.unblockPolicy,
      completionSummary: taskTable.completionSummary,
    })
    .from(taskTable)
    .where(eq(taskTable.id, id))
    .limit(1);

  if (!existingTask) {
    throw new HTTPException(404, {
      message: "Task not found",
    });
  }

  if (projectId !== existingTask.projectId) {
    throw new HTTPException(400, {
      message: "Use the task move endpoint to move tasks between projects",
    });
  }

  await assertValidTaskStatus(status, projectId);

  const resolvedWorkItemType =
    workItemType ?? (existingTask.workItemType as WorkItemType);
  if (resolvedWorkItemType !== existingTask.workItemType) {
    await assertWorkItemTypeChangeAllowed(id, resolvedWorkItemType);
  }

  const aiCaller = isAiTaskCaller(caller);
  const resolvedWorkflowFields = resolveTaskWorkflowFields(
    existingTask,
    status,
    workflowFields,
  );
  const column = await db.query.columnTable.findFirst({
    where: and(
      eq(columnTable.projectId, projectId),
      eq(columnTable.slug, status),
    ),
  });
  assertTaskWorkflowPolicy({
    isAiCaller: aiCaller,
    existing: existingTask,
    nextStatus: status,
    isFinalStatus: status === "done" || column?.isFinal === true,
    fields: {
      ...resolvedWorkflowFields,
      ...(existingTask.status !== "blocked" && status === "blocked"
        ? {
            blockedReason: workflowFields.blockedReason,
            unblockPolicy: workflowFields.unblockPolicy,
          }
        : {}),
    },
    unblockNote: workflowFields.unblockNote,
  });

  const [updatedTask] = await db
    .update(taskTable)
    .set({
      title,
      status,
      columnId: column?.id ?? null,
      startDate: startDate || null,
      dueDate: dueDate || null,
      projectId,
      description,
      ...resolvedWorkflowFields,
      priority,
      position,
      userId: userId || null,
      workItemType: resolvedWorkItemType,
      taskCategory: taskCategory ?? (existingTask.taskCategory as TaskCategory),
      strategyHorizons:
        strategyHorizons === undefined
          ? existingTask.strategyHorizons
          : normalizeTaskHorizons(strategyHorizons),
    })
    .where(eq(taskTable.id, id))
    .returning();

  if (!updatedTask) {
    throw new HTTPException(500, {
      message: "Failed to update task",
    });
  }

  if (existingTask.status !== status) {
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
  }

  await publishEvent("task.updated", {
    taskId: updatedTask.id,
    projectId: updatedTask.projectId,
    title: updatedTask.title,
    status: updatedTask.status,
    userId: currentUserId,
  });

  if (existingTask.description !== description) {
    deleteOrphanedAssets(existingTask.description, description, {
      taskId: id,
    }).catch(() => {});
  }

  return updatedTask;
}

export default updateTask;
