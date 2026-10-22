import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  assetTable,
  columnTable,
  labelTable,
  projectTable,
  taskRelationTable,
  taskTable,
  userTable,
  workspaceUserTable,
} from "../../database/schema";
import { publishEvent } from "../../events";
import { removeLabelFromGitea } from "../../plugins/gitea/utils/sync-label-to-gitea";
import { removeLabelFromGitHub } from "../../plugins/github/utils/sync-label-to-github";
import { deleteS3Keys } from "../../storage/cleanup-assets";
import { hasLockedWorkspacePermission } from "../../utils/require-workspace-permission";
import {
  assertTaskWorkflowPolicy,
  isAiTaskCaller,
  resolveTaskWorkflowFields,
} from "../task-workflow-policy";
import {
  assertValidPriority,
  assertValidTaskStatus,
} from "../validate-task-fields";

type BulkOperation =
  | "updateStatus"
  | "updatePriority"
  | "updateAssignee"
  | "delete"
  | "addLabel"
  | "removeLabel"
  | "updateDueDate";

export async function runBulkUpdateTasks(
  {
    taskIds,
    operation,
    value,
    userId,
    caller,
    unblockNote,
    expectedVersions,
    workspaceId: authorizedWorkspaceId,
  }: {
    taskIds: string[];
    operation: BulkOperation;
    value?: string | null;
    userId: string;
    caller?: string;
    unblockNote?: string | null;
    expectedVersions?: { id: string; version: number }[];
    workspaceId?: string;
  },
  options: {
    database?: typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
    emit?: typeof publishEvent;
    locked?: boolean;
    projectId?: string;
    assetCleanup?: (keys: string[]) => void;
    defer?: (action: () => void) => void;
  } = {},
) {
  const database = options.database ?? db;
  const emit = options.emit ?? publishEvent;
  const selectedWhere = and(
    inArray(taskTable.id, taskIds),
    options.projectId ? eq(taskTable.projectId, options.projectId) : undefined,
  );
  if (options.locked)
    await database
      .select({ id: taskTable.id })
      .from(taskTable)
      .where(selectedWhere)
      .orderBy(asc(taskTable.id))
      .for("update");
  const tasks = await database
    .select({
      id: taskTable.id,
      version: taskTable.version,
      title: taskTable.title,
      projectId: taskTable.projectId,
      userId: taskTable.userId,
      dueDate: taskTable.dueDate,
      status: taskTable.status,
      goal: taskTable.goal,
      acceptanceCriteria: taskTable.acceptanceCriteria,
      blockedReason: taskTable.blockedReason,
      unblockPolicy: taskTable.unblockPolicy,
      completionSummary: taskTable.completionSummary,
      isFinalStatus: sql<boolean>`${taskTable.status} = 'done' OR EXISTS (
        SELECT 1 FROM ${columnTable} WHERE ${columnTable.projectId} = ${taskTable.projectId}
        AND ${columnTable.slug} = ${taskTable.status} AND ${columnTable.isFinal} = true
      )`,
      workspaceId: projectTable.workspaceId,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(selectedWhere);

  if (tasks.length === 0) {
    throw new HTTPException(expectedVersions ? 409 : 404, {
      message: "No tasks found",
    });
  }

  const workspaceIds = [...new Set(tasks.map((t) => t.workspaceId))];

  if (workspaceIds.length > 1) {
    throw new HTTPException(400, {
      message: "All tasks must belong to the same workspace",
    });
  }

  const workspaceId = workspaceIds[0];

  if (!workspaceId) {
    throw new HTTPException(400, {
      message: "Could not determine workspace",
    });
  }
  if (authorizedWorkspaceId && workspaceId !== authorizedWorkspaceId)
    throw new HTTPException(409, {
      message: "Task workspace changed; reload before retrying",
    });

  const [membership] = await database
    .select({ id: workspaceUserTable.id })
    .from(workspaceUserTable)
    .where(
      and(
        eq(workspaceUserTable.userId, userId),
        eq(workspaceUserTable.workspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (!membership) {
    throw new HTTPException(403, {
      message: "You don't have access to this workspace",
    });
  }

  if (expectedVersions) {
    const versions = new Map(
      expectedVersions.map((task) => [task.id, task.version]),
    );
    if (
      new Set(taskIds).size !== taskIds.length ||
      versions.size !== expectedVersions.length ||
      versions.size !== taskIds.length ||
      taskIds.some((id) => !versions.has(id))
    )
      throw new HTTPException(400, {
        message: "Provide one expected version for every selected task",
      });
    if (
      tasks.length !== taskIds.length ||
      tasks.some((task) => versions.get(task.id) !== task.version)
    )
      throw new HTTPException(409, {
        res: Response.json(
          {
            error: "TASK_CONFLICT",
            message: "Selected tasks changed; reload before retrying",
          },
          { status: 409 },
        ),
      });
  }

  const foundIds = tasks.map((t) => t.id);
  const aiCaller = isAiTaskCaller(caller);
  let updatedCount = 0;

  switch (operation) {
    case "updateStatus": {
      if (!value) {
        throw new HTTPException(400, { message: "Status value is required" });
      }
      const projectIds = [...new Set(tasks.map((t) => t.projectId))];

      for (const projectId of projectIds) {
        await assertValidTaskStatus(value, projectId, database);

        const column = await database.query.columnTable.findFirst({
          where: and(
            eq(columnTable.projectId, projectId),
            eq(columnTable.slug, value),
          ),
        });

        for (const task of tasks.filter(
          (item) => item.projectId === projectId,
        )) {
          assertTaskWorkflowPolicy({
            isAiCaller: aiCaller,
            existing: task,
            nextStatus: value,
            isFinalStatus: value === "done" || column?.isFinal === true,
            fields: task,
            unblockNote,
          });
        }

        const projectTaskIds = tasks
          .filter((t) => t.projectId === projectId)
          .map((t) => t.id);

        for (const task of tasks.filter(
          (item) => item.projectId === projectId,
        )) {
          const workflowFields = resolveTaskWorkflowFields(task, value, {});
          const result = await database
            .update(taskTable)
            .set({
              status: value,
              columnId: column?.id ?? null,
              ...workflowFields,
            })
            .where(eq(taskTable.id, task.id));

          updatedCount += result.rowCount ?? 1;
        }

        for (const taskId of projectTaskIds) {
          await emit("task.status_changed", {
            taskId,
            projectId,
            userId,
            newStatus: value,
            type: "status_changed",
          });
        }

        await emit("task-relation.refresh", {
          projectId,
          userId,
        });
      }
      break;
    }

    case "updatePriority": {
      if (!value) {
        throw new HTTPException(400, { message: "Priority value is required" });
      }
      assertValidPriority(value);
      for (const task of tasks) {
        assertTaskWorkflowPolicy({
          isAiCaller: aiCaller,
          existing: task,
          nextStatus: task.status,
          isFinalStatus: task.isFinalStatus,
          fields: task,
        });
      }

      const result = await database
        .update(taskTable)
        .set({ priority: value })
        .where(inArray(taskTable.id, foundIds));

      updatedCount = result.rowCount ?? foundIds.length;

      for (const task of tasks) {
        await emit("task.priority_changed", {
          taskId: task.id,
          projectId: task.projectId,
          userId,
          newPriority: value,
          type: "priority_changed",
        });
      }
      break;
    }

    case "updateAssignee": {
      for (const task of tasks) {
        assertTaskWorkflowPolicy({
          isAiCaller: aiCaller,
          existing: task,
          nextStatus: task.status,
          isFinalStatus: task.isFinalStatus,
          fields: task,
        });
      }
      const newAssigneeName = value
        ? (
            await database
              .select({ name: userTable.name })
              .from(userTable)
              .where(eq(userTable.id, value))
              .limit(1)
          )[0]?.name
        : undefined;

      const result = await database
        .update(taskTable)
        .set({ userId: value || null })
        .where(inArray(taskTable.id, foundIds));

      updatedCount = result.rowCount ?? foundIds.length;

      for (const task of tasks) {
        const eventType = value ? "task.assignee_changed" : "task.unassigned";
        await emit(eventType, {
          taskId: task.id,
          projectId: task.projectId,
          userId,
          oldAssignee: task.userId,
          newAssignee: newAssigneeName,
          newAssigneeId: value || null,
          title: task.title,
          type: value ? "assignee_changed" : "unassigned",
        });
      }
      break;
    }

    case "delete": {
      const assets = await database
        .select({ objectKey: assetTable.objectKey })
        .from(assetTable)
        .where(inArray(assetTable.taskId, foundIds));
      const relations = await database
        .select()
        .from(taskRelationTable)
        .where(
          or(
            inArray(taskRelationTable.sourceTaskId, foundIds),
            inArray(taskRelationTable.targetTaskId, foundIds),
          ),
        );
      const result = await database
        .delete(taskTable)
        .where(inArray(taskTable.id, foundIds));

      updatedCount = result.rowCount ?? foundIds.length;

      for (const task of tasks) {
        await emit("task.deleted", {
          taskId: task.id,
          projectId: task.projectId,
          userId,
          title: task.title,
        });
      }
      for (const relation of relations) {
        const task =
          tasks.find((task) => task.id === relation.sourceTaskId) ??
          tasks.find((task) => task.id === relation.targetTaskId)!;
        await emit("task-relation.deleted", {
          projectId: task.projectId,
          userId,
          taskId: task.id,
          sourceTaskId: relation.sourceTaskId,
          targetTaskId: relation.targetTaskId,
        });
      }
      if (assets.length && options.assetCleanup)
        options.assetCleanup(assets.map((asset) => asset.objectKey));
      else if (assets.length)
        options.defer?.(() => {
          void deleteS3Keys(assets.map((asset) => asset.objectKey)).catch(
            () => {},
          );
        });
      break;
    }

    case "addLabel": {
      if (!value) {
        throw new HTTPException(400, { message: "Label ID is required" });
      }

      const [label] = await database
        .select()
        .from(labelTable)
        .where(eq(labelTable.id, value))
        .for("update");

      if (!label) {
        throw new HTTPException(404, { message: "Label not found" });
      }

      if (label.workspaceId && label.workspaceId !== workspaceId) {
        throw new HTTPException(400, {
          message: "Label and tasks must belong to the same workspace",
        });
      }

      for (const task of tasks) {
        const existingAssignment = await database.query.labelTable.findFirst({
          where: and(
            eq(labelTable.name, label.name),
            eq(labelTable.taskId, task.id),
          ),
        });

        if (!existingAssignment) {
          const inserted = await database
            .insert(labelTable)
            .values({
              name: label.name,
              color: label.color,
              workspaceId: workspaceId,
              taskId: task.id,
            })
            .onConflictDoNothing({
              target: [labelTable.taskId, labelTable.name],
            })
            .returning({ id: labelTable.id });
          if (inserted.length === 0) continue;
          await database
            .update(taskTable)
            .set({ updatedAt: new Date() })
            .where(eq(taskTable.id, task.id));
          updatedCount++;

          await emit("task.label_assigned", {
            projectId: task.projectId,
            taskId: task.id,
            userId,
            type: "label_assigned",
          });
        }
      }
      break;
    }

    case "removeLabel": {
      if (!value) {
        throw new HTTPException(400, { message: "Label ID is required" });
      }

      const [label] = await database
        .select()
        .from(labelTable)
        .where(eq(labelTable.id, value))
        .for("update");

      if (!label) {
        throw new HTTPException(404, { message: "Label not found" });
      }

      if (label.workspaceId && label.workspaceId !== workspaceId)
        throw new HTTPException(400, {
          message: "Label and tasks must belong to the same workspace",
        });

      const deletedLabels = await database
        .delete(labelTable)
        .where(
          and(
            eq(labelTable.workspaceId, workspaceId),
            eq(labelTable.name, label.name),
            inArray(labelTable.taskId, foundIds),
          ),
        )
        .returning();

      updatedCount = deletedLabels.length;
      const changedIds = [
        ...new Set(
          deletedLabels.flatMap((label) =>
            label.taskId ? [label.taskId] : [],
          ),
        ),
      ];
      if (changedIds.length)
        await database
          .update(taskTable)
          .set({ updatedAt: new Date() })
          .where(inArray(taskTable.id, changedIds));

      for (const deletedLabel of deletedLabels) {
        if (!deletedLabel.taskId) continue;

        const sync = () => {
          removeLabelFromGitHub(deletedLabel.taskId!, deletedLabel.name).catch(
            (error) => {
              console.error("Failed to remove label from GitHub:", error);
            },
          );
          removeLabelFromGitea(deletedLabel.taskId!, deletedLabel.name).catch(
            (error) => {
              console.error("Failed to remove label from Gitea:", error);
            },
          );
        };
        if (options.defer) options.defer(sync);
        else sync();

        const task = tasks.find((t) => t.id === deletedLabel.taskId);
        if (!task) continue;

        await emit("task.label_unassigned", {
          label: deletedLabel,
          task,
          projectId: task.projectId,
          taskId: deletedLabel.taskId,
          userId,
          type: "label_unassigned",
        });
      }
      break;
    }

    case "updateDueDate": {
      for (const task of tasks) {
        assertTaskWorkflowPolicy({
          isAiCaller: aiCaller,
          existing: task,
          nextStatus: task.status,
          isFinalStatus: task.isFinalStatus,
          fields: task,
        });
      }
      let parsedDate: Date | null = null;
      if (value) {
        parsedDate = new Date(value);
        if (Number.isNaN(parsedDate.getTime())) {
          throw new HTTPException(400, {
            message: `Invalid date value "${value}"`,
          });
        }
      }

      const result = await database
        .update(taskTable)
        .set({ dueDate: parsedDate })
        .where(inArray(taskTable.id, foundIds));

      updatedCount = result.rowCount ?? foundIds.length;

      for (const task of tasks) {
        await emit("task.due_date_changed", {
          taskId: task.id,
          projectId: task.projectId,
          userId,
          oldDueDate: task.dueDate,
          newDueDate: parsedDate,
          title: task.title,
          type: "due_date_changed",
        });
      }
      break;
    }

    default: {
      throw new HTTPException(400, {
        message: `Unknown operation "${operation}"`,
      });
    }
  }

  return { success: true, updatedCount };
}

async function bulkUpdateTasks(
  input: Parameters<typeof runBulkUpdateTasks>[0],
) {
  if (
    input.operation === "delete" &&
    (!input.expectedVersions || input.taskIds.length > 100)
  )
    throw new HTTPException(400, {
      message: "Delete requires up to 100 tasks with one expected version each",
    });
  if (
    ![
      "updateStatus",
      "updatePriority",
      "updateAssignee",
      "updateDueDate",
      "addLabel",
      "removeLabel",
      "delete",
    ].includes(input.operation)
  ) {
    return runBulkUpdateTasks(input);
  }
  const pending: Array<Parameters<typeof publishEvent>> = [];
  const deferred: (() => void)[] = [];
  const emit: typeof publishEvent = async (...event) => {
    pending.push(event);
  };
  const result = await db.transaction(async (tx) => {
    if (input.operation === "delete") {
      const bindings = await tx
        .select({ projectId: taskTable.projectId })
        .from(taskTable)
        .where(inArray(taskTable.id, input.taskIds));
      const projectIds = [
        ...new Set(bindings.map((task) => task.projectId)),
      ].sort();
      if (!projectIds.length)
        throw new HTTPException(409, {
          message: "Selected tasks changed; reload before retrying",
        });
      const projects = await tx
        .select({ id: projectTable.id, workspaceId: projectTable.workspaceId })
        .from(projectTable)
        .where(inArray(projectTable.id, projectIds))
        .orderBy(asc(projectTable.id))
        .for("update");
      const workspaceIds = [
        ...new Set(projects.map((project) => project.workspaceId)),
      ];
      const deleteWorkspaceId = workspaceIds[0];
      if (
        !deleteWorkspaceId ||
        workspaceIds.length !== 1 ||
        (input.workspaceId && deleteWorkspaceId !== input.workspaceId)
      )
        throw new HTTPException(409, {
          message: "Selected task workspace changed; reload before retrying",
        });
      if (
        !(await hasLockedWorkspacePermission(
          tx,
          input.userId,
          deleteWorkspaceId,
          { task: ["delete"] },
        ))
      )
        throw new HTTPException(403, {
          message: "Task delete permission required",
        });
      await tx
        .select({ id: taskTable.id })
        .from(taskTable)
        .where(inArray(taskTable.id, input.taskIds))
        .orderBy(asc(taskTable.id))
        .for("update");
      const current = await tx
        .select({ projectId: taskTable.projectId })
        .from(taskTable)
        .where(inArray(taskTable.id, input.taskIds));
      if (current.some((task) => !projectIds.includes(task.projectId)))
        throw new HTTPException(409, {
          message: "Selected task project changed; reload before retrying",
        });
    }
    return runBulkUpdateTasks(input, {
      database: tx,
      emit,
      locked: true,
      defer: (action) => deferred.push(action),
    });
  });
  for (const action of deferred) action();
  for (const event of pending) await publishEvent(...event);
  return result;
}
export default bulkUpdateTasks;
