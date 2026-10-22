import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  columnTable,
  projectTable,
  projectTaskOperationTable,
  taskGroupEventTable,
  taskTable,
} from "../../database/schema";
import { hasLockedWorkspacePermission } from "../../utils/require-workspace-permission";
import {
  assertTaskWorkflowPolicy,
  isAiTaskCaller,
} from "../task-workflow-policy";
import { VIRTUAL_STATUSES } from "../validate-task-fields";

function conflict(message: string): never {
  throw new HTTPException(409, {
    res: Response.json({ error: "TASK_CONFLICT", message }, { status: 409 }),
  });
}

/** Apply confirmed complete group and save replay result in same transaction. */
export default async function applyTaskGroup(
  projectId: string,
  operationId: string,
  userId: string,
  workspaceId: string,
  caller?: string,
) {
  const committed = await db.transaction(async (tx) => {
    const [project] = await tx
      .select({ id: projectTable.id })
      .from(projectTable)
      .where(
        and(
          eq(projectTable.id, projectId),
          eq(projectTable.workspaceId, workspaceId),
        ),
      )
      .for("update");
    if (!project)
      throw new HTTPException(404, {
        message: "Project not found in authorized workspace",
      });
    if (
      !(await hasLockedWorkspacePermission(tx, userId, workspaceId, {
        task: ["update"],
      }))
    )
      throw new HTTPException(403, {
        message: "Task update permission required",
      });
    const [operation] = await tx
      .select()
      .from(projectTaskOperationTable)
      .where(
        and(
          eq(projectTaskOperationTable.id, operationId),
          eq(projectTaskOperationTable.projectId, projectId),
          eq(projectTaskOperationTable.workspaceId, workspaceId),
          eq(projectTaskOperationTable.userId, userId),
        ),
      )
      .for("update");
    if (!operation)
      throw new HTTPException(404, {
        message: "Group operation not found for caller",
      });
    if (operation.appliedAt) return operation.result;
    if (operation.expiresAt.getTime() <= Date.now())
      throw new HTTPException(410, {
        message: "Group snapshot expired; prepare again",
      });
    const { action, sourceStatus, targetStatus } = operation.intent;
    if (typeof sourceStatus !== "string" || typeof targetStatus !== "string")
      conflict("Invalid stored group intent");
    if (
      !(
        (action === "archive_column" && targetStatus === "archived") ||
        (action === "activate_planned" && sourceStatus === "planned")
      )
    )
      conflict("Invalid stored group intent");
    if (
      sourceStatus === targetStatus ||
      (action === "activate_planned" &&
        (VIRTUAL_STATUSES as readonly string[]).includes(targetStatus))
    )
      conflict("Group target must be different actual project column");
    const columns = await tx
      .select()
      .from(columnTable)
      .where(eq(columnTable.projectId, projectId))
      .orderBy(asc(columnTable.id))
      .for("share");
    const source = columns.find((column) => column.slug === sourceStatus);
    const target = columns.find((column) => column.slug === targetStatus);
    if (
      action === "archive_column" &&
      (!source?.isFinal || source.id !== operation.result.sourceColumnId)
    )
      conflict("Source final column changed; prepare again");
    if (
      action === "activate_planned" &&
      (!target || target.id !== operation.result.targetColumnId)
    )
      conflict("Target column changed; prepare again");
    // Protect existing tasks joining/leaving group; project lock blocks new FK inserts.
    const projectTasks = await tx
      .select({
        id: taskTable.id,
        version: taskTable.version,
        status: taskTable.status,
      })
      .from(taskTable)
      .where(eq(taskTable.projectId, projectId))
      .orderBy(asc(taskTable.id))
      .for("update");
    const current = projectTasks.filter((task) => task.status === sourceStatus);
    const versions = new Map(
      operation.snapshot.map((task) => [task.id, task.version]),
    );
    if (
      versions.size !== operation.snapshot.length ||
      current.length !== operation.snapshot.length ||
      current.some((task) => versions.get(task.id) !== task.version)
    )
      conflict("Task group changed; reload and prepare again");
    if (isAiTaskCaller(caller)) {
      const policyTasks = await tx
        .select({
          status: taskTable.status,
          goal: taskTable.goal,
          acceptanceCriteria: taskTable.acceptanceCriteria,
          completionSummary: taskTable.completionSummary,
          blockedReason: taskTable.blockedReason,
          unblockPolicy: taskTable.unblockPolicy,
        })
        .from(taskTable)
        .where(
          and(
            eq(taskTable.projectId, projectId),
            eq(taskTable.status, sourceStatus),
          ),
        );
      for (const task of policyTasks)
        assertTaskWorkflowPolicy({
          isAiCaller: true,
          existing: task,
          nextStatus: targetStatus,
          isFinalStatus: targetStatus === "done" || target?.isFinal === true,
          fields: task,
        });
    }
    const changed = await tx
      .update(taskTable)
      .set({
        status: targetStatus,
        columnId: target?.id ?? null,
        blockedReason: null,
        unblockPolicy: null,
      })
      .where(
        and(
          eq(taskTable.projectId, projectId),
          eq(taskTable.status, sourceStatus),
        ),
      )
      .returning({
        id: taskTable.id,
        title: taskTable.title,
        assigneeId: taskTable.userId,
      });
    if (changed.length !== current.length)
      conflict("Task group update was incomplete");
    const pending = changed.map((task) => {
      const id = createHash("sha256")
        .update(`${operationId}:${task.id}`)
        .digest("hex");
      return {
        id,
        operationId,
        payload: {
          taskId: task.id,
          projectId,
          userId,
          oldStatus: sourceStatus,
          newStatus: targetStatus,
          title: task.title,
          assigneeId: task.assigneeId,
          type: "status_changed",
          operationKey: id,
          initiatorId: userId,
        },
      };
    });
    // Bounded SQL parameter count even for large complete groups.
    for (let offset = 0; offset < pending.length; offset += 500) {
      const saved = await tx
        .insert(taskGroupEventTable)
        .values(pending.slice(offset, offset + 500))
        .returning({ id: taskGroupEventTable.id });
      if (saved.length !== Math.min(500, pending.length - offset))
        conflict("Group events could not be saved");
    }
    const appliedAt = new Date();
    const result = {
      ...operation.result,
      applied: true,
      updatedCount: changed.length,
      appliedAt: appliedAt.toISOString(),
    };
    const saved = await tx
      .update(projectTaskOperationTable)
      .set({ result, appliedAt, snapshot: [] })
      .where(eq(projectTaskOperationTable.id, operationId))
      .returning({ id: projectTaskOperationTable.id });
    if (saved.length !== 1)
      conflict("Group operation result could not be saved");
    return result;
  });
  return committed;
}
