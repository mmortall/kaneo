import { and, eq, max } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { columnTable, taskTable, userTable } from "../../database/schema";
import { publishEvent } from "../../events";
import type { TaskCategory } from "../task-category";
import { normalizeTaskHorizons, type TaskHorizon } from "../task-horizon";
import {
  assertTaskWorkflowPolicy,
  isAiTaskCaller,
  resolveTaskWorkflowFields,
} from "../task-workflow-policy";
import { assertValidTaskStatus } from "../validate-task-fields";
import { claimTaskNumber } from "./claim-task-numbers";

async function createTask({
  projectId,
  currentUserId,
  userId,
  title,
  status,
  startDate,
  dueDate,
  description,
  priority,
  workItemType,
  taskCategory,
  strategyHorizons,
  goal,
  acceptanceCriteria,
  blockedReason,
  unblockPolicy,
  completionSummary,
  caller,
}: {
  projectId: string;
  currentUserId: string;
  userId?: string;
  title: string;
  status: string;
  startDate?: Date;
  dueDate?: Date;
  description?: string;
  priority?: string;
  workItemType?: "task" | "epic" | "sub_epic";
  taskCategory?: TaskCategory;
  strategyHorizons?: TaskHorizon[];
  goal?: string;
  acceptanceCriteria?: string;
  blockedReason?: string;
  unblockPolicy?: string;
  completionSummary?: string;
  caller?: string;
}) {
  const resolvedStatus = status || "to-do";
  const resolvedPriority = priority || "no-priority";

  await assertValidTaskStatus(resolvedStatus, projectId);

  const workflowInput = {
    goal,
    acceptanceCriteria,
    blockedReason,
    unblockPolicy,
    completionSummary,
  };
  assertTaskWorkflowPolicy({
    isAiCaller: isAiTaskCaller(caller),
    nextStatus: resolvedStatus,
    fields: workflowInput,
  });
  const workflowFields = resolveTaskWorkflowFields(
    undefined,
    resolvedStatus,
    workflowInput,
  );

  const [assignee] = await db
    .select({ name: userTable.name })
    .from(userTable)
    .where(eq(userTable.id, userId ?? ""));

  const column = await db.query.columnTable.findFirst({
    where: and(
      eq(columnTable.projectId, projectId),
      eq(columnTable.slug, resolvedStatus),
    ),
  });

  const [maxPositionResult] = await db
    .select({ maxPosition: max(taskTable.position) })
    .from(taskTable)
    .where(
      and(
        eq(taskTable.projectId, projectId),
        column?.id
          ? eq(taskTable.columnId, column.id)
          : eq(taskTable.status, resolvedStatus),
      ),
    );

  const nextPosition = (maxPositionResult?.maxPosition ?? 0) + 1;

  const createdTask = await db.transaction(async (tx) => {
    const taskNumber = await claimTaskNumber(projectId, tx);

    const [task] = await tx
      .insert(taskTable)
      .values({
        projectId,
        userId: userId || null,
        title: title || "",
        status: resolvedStatus,
        columnId: column?.id ?? null,
        startDate: startDate || null,
        dueDate: dueDate || null,
        description: description || "",
        ...workflowFields,
        priority: resolvedPriority,
        workItemType: workItemType ?? "task",
        taskCategory: taskCategory ?? "live_implementation",
        strategyHorizons: normalizeTaskHorizons(strategyHorizons),
        number: taskNumber,
        position: nextPosition,
      })
      .returning();

    return task;
  });

  if (!createdTask) {
    throw new HTTPException(500, {
      message: "Failed to create task",
    });
  }

  await publishEvent("task.created", {
    ...createdTask,
    taskId: createdTask.id,
    userId: createdTask.userId ?? "",
    currentUserId: currentUserId,
    type: "created",
    content: null,
  });

  return {
    ...createdTask,
    assigneeName: assignee?.name,
  };
}

export default createTask;
