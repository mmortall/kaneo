import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { columnTable, projectTable, taskTable } from "../../database/schema";
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
import lockTaskTypeProject from "./lock-task-type-project";

async function runUpdateTask(
  id: string,
  title: string,
  status: string,
  startDate: Date | undefined,
  dueDate: Date | undefined,
  projectId: string,
  description: string | null,
  priority: string | null,
  position: number | null,
  userId?: string,
  workItemType?: WorkItemType,
  taskCategory?: TaskCategory,
  strategyHorizons?: TaskHorizon[],
  _currentUserId?: string,
  workflowFields: {
    goal?: string;
    acceptanceCriteria?: string;
    blockedReason?: string;
    unblockPolicy?: string;
    completionSummary?: string;
    unblockNote?: string;
  } = {},
  caller?: string,
  options: {
    database?: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
    expectedVersion?: number;
    skipEvents?: boolean;
    workspaceId?: string;
    partialFields?: readonly string[];
  } = {},
) {
  const database = options.database ?? db;
  const [existingTask] = await database
    .select({
      id: taskTable.id,
      version: taskTable.version,
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
  if (
    options.expectedVersion !== undefined &&
    existingTask.version !== options.expectedVersion
  ) {
    throw new HTTPException(409, {
      message: `Task conflict: current version ${existingTask.version}`,
    });
  }

  if (projectId !== existingTask.projectId) {
    throw new HTTPException(400, {
      message: "Use the task move endpoint to move tasks between projects",
    });
  }

  await assertValidTaskStatus(status, projectId, database);

  const resolvedWorkItemType =
    workItemType ?? (existingTask.workItemType as WorkItemType);
  if (resolvedWorkItemType !== existingTask.workItemType) {
    await assertWorkItemTypeChangeAllowed(id, resolvedWorkItemType, database);
  }

  const aiCaller = isAiTaskCaller(caller);
  const resolvedWorkflowFields = resolveTaskWorkflowFields(
    existingTask,
    status,
    workflowFields,
  );
  const column = await database.query.columnTable.findFirst({
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

  const values = {
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
  };
  if (options.partialFields) {
    const supplied = new Set(options.partialFields);
    if (supplied.has("status")) {
      supplied.add("columnId");
      for (const field of Object.keys(resolvedWorkflowFields))
        supplied.add(field);
    }
    for (const field of Object.keys(values) as (keyof typeof values)[]) {
      if (!supplied.has(field)) delete values[field];
    }
    if (Object.keys(values).length === 0)
      throw new HTTPException(400, {
        message: "At least one task field is required",
      });
  }
  const [updatedTask] = await database
    .update(taskTable)
    .set(values)
    .where(
      and(
        eq(taskTable.id, id),
        ...(options.expectedVersion === undefined
          ? []
          : [eq(taskTable.version, options.expectedVersion)]),
      ),
    )
    .returning();

  if (!updatedTask) {
    throw new HTTPException(options.expectedVersion === undefined ? 500 : 409, {
      message:
        options.expectedVersion === undefined
          ? "Failed to update task"
          : "Task changed; reload before retrying",
    });
  }

  return { updatedTask, existingTask };
}

type UpdateTaskArgs = Parameters<typeof runUpdateTask>;

async function updateTask(...args: UpdateTaskArgs) {
  const options = args[16] ?? {};
  const execute = async (
    database: NonNullable<UpdateTaskArgs[16]>["database"],
  ) => {
    const callArgs: UpdateTaskArgs = [...args];
    callArgs[16] = { ...options, database };
    return runUpdateTask(...callArgs);
  };
  const result = options.database
    ? await execute(options.database)
    : await db.transaction(async (tx) => {
        const lockedProject =
          args[10] === undefined
            ? undefined
            : await lockTaskTypeProject(tx, args[0], options.workspaceId);
        const [locked] = await tx
          .select({ id: taskTable.id, projectId: taskTable.projectId })
          .from(taskTable)
          .where(eq(taskTable.id, args[0]))
          .for("update");
        if (!locked)
          throw new HTTPException(404, { message: "Task not found" });
        if (lockedProject && locked.projectId !== lockedProject)
          throw new HTTPException(409, {
            message:
              "Task moved during type validation; reload before retrying",
          });
        if (options.workspaceId) {
          const [authorized] = await tx
            .select({ id: projectTable.id })
            .from(projectTable)
            .where(
              and(
                eq(projectTable.id, locked.projectId),
                eq(projectTable.workspaceId, options.workspaceId),
              ),
            );
          if (!authorized)
            throw new HTTPException(409, {
              message: "Task workspace changed; reload before retrying",
            });
        }
        return execute(tx);
      });
  const { updatedTask, existingTask } = result;
  const currentUserId = args[13];
  const description = args[6];
  const status = args[2];
  const id = args[0];
  if (options.skipEvents) return updatedTask;
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
    deleteOrphanedAssets(existingTask.description, description ?? "", {
      taskId: id,
    }).catch(() => {});
  }

  return updatedTask;
}

export default updateTask;
