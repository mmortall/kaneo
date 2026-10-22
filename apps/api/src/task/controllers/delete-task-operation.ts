import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  projectTable,
  projectTaskOperationTable,
  taskGroupEventTable,
} from "../../database/schema";
import { hasLockedWorkspacePermission } from "../../utils/require-workspace-permission";
import { runBulkUpdateTasks } from "./bulk-update-tasks";

export type DeleteSelection = { id: string; version: number }[];
export type DeleteReceipt = {
  operationId: string;
  projectId: string;
  success: true;
  deletedCount: number;
  taskIds: string[];
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const deleteOperationId = (
  projectId: string,
  userId: string,
  key: string,
) => hash(["delete_selected", projectId, userId, key]);
function conflict(message: string): never {
  throw new HTTPException(409, {
    res: Response.json({ error: "TASK_CONFLICT", message }, { status: 409 }),
  });
}

/** Persist deletion, receipt and delivery intents atomically; task absence never implies success. */
export async function deleteTaskOperation(
  projectId: string,
  userId: string,
  workspaceId: string,
  key: string,
  selection: DeleteSelection,
): Promise<DeleteReceipt> {
  if (
    !/^[\w:.-]{1,128}$/.test(key) ||
    !selection.length ||
    selection.length > 100 ||
    new Set(selection.map((task) => task.id)).size !== selection.length ||
    selection.some(
      (task) => !Number.isSafeInteger(task.version) || task.version < 1,
    )
  )
    throw new HTTPException(400, {
      message:
        "Provide valid operation key and up to 100 unique reviewed tasks",
    });
  const tasks = [...selection].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const operationId = deleteOperationId(projectId, userId, key);
  const bodyHash = hash(tasks);
  return db.transaction(async (tx) => {
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
      throw new HTTPException(404, { message: "Project not found" });
    if (
      !(await hasLockedWorkspacePermission(tx, userId, workspaceId, {
        task: ["delete"],
      }))
    )
      throw new HTTPException(403, {
        message: "Task delete permission required",
      });
    const [previous] = await tx
      .select()
      .from(projectTaskOperationTable)
      .where(eq(projectTaskOperationTable.id, operationId));
    if (previous) {
      if (
        previous.bodyHash !== bodyHash ||
        previous.intent.action !== "delete_selected"
      )
        conflict("Operation key reused with another deletion selection");
      if (!previous.appliedAt) conflict("Deletion operation is incomplete");
      return previous.result as DeleteReceipt;
    }
    const effects: Record<string, unknown>[] = [];
    const result = await runBulkUpdateTasks(
      {
        taskIds: tasks.map((task) => task.id),
        expectedVersions: tasks,
        operation: "delete",
        userId,
        workspaceId,
      },
      {
        database: tx,
        projectId,
        locked: true,
        emit: async (eventType, data) => {
          if (
            eventType !== "task.deleted" &&
            eventType !== "task-relation.deleted"
          )
            throw new Error("Unexpected deletion event");
          effects.push({
            ...(data as Record<string, unknown>),
            deliveryType: eventType,
            initiatorId: userId,
          });
        },
        assetCleanup: (keys) => {
          for (const objectKey of keys)
            effects.push({
              deliveryType: "asset.delete",
              objectKey,
              initiatorId: userId,
            });
        },
      },
    );
    if (result.updatedCount !== tasks.length)
      conflict("Deletion selection changed");
    const receipt: DeleteReceipt = {
      operationId,
      projectId,
      success: true,
      deletedCount: tasks.length,
      taskIds: tasks.map((task) => task.id),
    };
    await tx.insert(projectTaskOperationTable).values({
      id: operationId,
      projectId,
      workspaceId,
      userId,
      bodyHash,
      intent: { action: "delete_selected" },
      snapshot: [],
      result: receipt,
      appliedAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
    });
    const pending = effects.map((payload, index) => {
      const id = hash([operationId, index]);
      return { id, operationId, payload: { ...payload, operationKey: id } };
    });
    for (let offset = 0; offset < pending.length; offset += 500)
      await tx
        .insert(taskGroupEventTable)
        .values(pending.slice(offset, offset + 500));
    return receipt;
  });
}

/** Resolve only caller-owned deletion receipt after current project authorization. */
export async function getDeleteReceipt(
  projectId: string,
  userId: string,
  workspaceId: string,
  key: string,
): Promise<DeleteReceipt | null> {
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select({ id: projectTable.id })
      .from(projectTable)
      .where(
        and(
          eq(projectTable.id, projectId),
          eq(projectTable.workspaceId, workspaceId),
        ),
      )
      .for("share");
    if (!project)
      throw new HTTPException(404, { message: "Project not found" });
    if (
      !(await hasLockedWorkspacePermission(tx, userId, workspaceId, {
        task: ["delete"],
      }))
    )
      throw new HTTPException(403, {
        message: "Task delete permission required",
      });
    const [operation] = await tx
      .select()
      .from(projectTaskOperationTable)
      .where(
        and(
          eq(
            projectTaskOperationTable.id,
            deleteOperationId(projectId, userId, key),
          ),
          eq(projectTaskOperationTable.projectId, projectId),
          eq(projectTaskOperationTable.userId, userId),
          eq(projectTaskOperationTable.workspaceId, workspaceId),
        ),
      );
    return operation?.intent.action === "delete_selected" && operation.appliedAt
      ? (operation.result as DeleteReceipt)
      : null;
  });
}
