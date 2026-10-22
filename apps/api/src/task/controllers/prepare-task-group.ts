import { createHash } from "node:crypto";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  columnTable,
  projectTable,
  projectTaskOperationTable,
  taskTable,
  workspaceUserTable,
} from "../../database/schema";
import { VIRTUAL_STATUSES } from "../validate-task-fields";

export type TaskGroupIntent =
  | { action: "archive_column"; sourceStatus: string }
  | { action: "activate_planned"; targetStatus: string };

/** Capture complete group revisions on server; retry never silently recaptures it. */
export default async function prepareTaskGroup(
  projectId: string,
  intent: TaskGroupIntent,
  userId: string,
  workspaceId: string,
  key: string,
) {
  if (!/^[\w:.-]{1,128}$/.test(key))
    throw new HTTPException(400, {
      message: "Valid Idempotency-Key is required",
    });
  const columnStatus =
    intent.action === "archive_column"
      ? intent.sourceStatus
      : intent.targetStatus;
  if ((VIRTUAL_STATUSES as readonly string[]).includes(columnStatus))
    throw new HTTPException(400, {
      message: "Group action requires actual project column",
    });
  const request =
    intent.action === "archive_column"
      ? {
          action: intent.action,
          sourceStatus: intent.sourceStatus,
          targetStatus: "archived",
        }
      : {
          action: intent.action,
          sourceStatus: "planned",
          targetStatus: intent.targetStatus,
        };
  const id = createHash("sha256")
    .update(JSON.stringify(["task-group", workspaceId, projectId, userId, key]))
    .digest("hex");
  const bodyHash = createHash("sha256")
    .update(JSON.stringify(request))
    .digest("hex");
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
      throw new HTTPException(404, {
        message: "Project not found in authorized workspace",
      });
    const [member] = await tx
      .select({ id: workspaceUserTable.id })
      .from(workspaceUserTable)
      .where(
        and(
          eq(workspaceUserTable.workspaceId, workspaceId),
          eq(workspaceUserTable.userId, userId),
        ),
      )
      .limit(1);
    if (!member)
      throw new HTTPException(403, {
        message: "Workspace membership required",
      });
    const [existing] = await tx
      .select()
      .from(projectTaskOperationTable)
      .where(eq(projectTaskOperationTable.id, id));
    if (existing) {
      if (existing.bodyHash !== bodyHash)
        throw new HTTPException(409, {
          message: "Idempotency key has different group intent",
        });
      if (!existing.appliedAt && existing.expiresAt.getTime() <= Date.now())
        throw new HTTPException(410, {
          message: "Group snapshot expired; prepare with new key",
        });
      return existing.result;
    }
    const source =
      intent.action === "archive_column"
        ? await tx.query.columnTable.findFirst({
            where: and(
              eq(columnTable.projectId, projectId),
              eq(columnTable.slug, intent.sourceStatus),
            ),
          })
        : undefined;
    if (intent.action === "archive_column" && !source?.isFinal)
      throw new HTTPException(400, {
        message: "Archive group requires final project column",
      });
    const target =
      intent.action === "activate_planned"
        ? await tx.query.columnTable.findFirst({
            where: and(
              eq(columnTable.projectId, projectId),
              eq(columnTable.slug, intent.targetStatus),
            ),
          })
        : undefined;
    if (intent.action === "activate_planned" && !target)
      throw new HTTPException(400, {
        message: "Target project column required",
      });
    const snapshot = await tx
      .select({ id: taskTable.id, version: taskTable.version })
      .from(taskTable)
      .where(
        and(
          eq(taskTable.projectId, projectId),
          eq(taskTable.status, request.sourceStatus),
        ),
      )
      .orderBy(asc(taskTable.id));
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    const result = {
      operationId: id,
      projectId,
      ...request,
      sourceColumnId: source?.id ?? null,
      targetColumnId: target?.id ?? null,
      count: snapshot.length,
      expiresAt: expiresAt.toISOString(),
      applied: false,
    };
    // Keep expired key tombstones, while dropping payload on next preparation.
    await tx
      .update(projectTaskOperationTable)
      .set({ snapshot: [] })
      .where(
        and(
          eq(projectTaskOperationTable.projectId, projectId),
          isNull(projectTaskOperationTable.appliedAt),
          lte(projectTaskOperationTable.expiresAt, new Date()),
          sql`jsonb_array_length(${projectTaskOperationTable.snapshot}) > 0`,
        ),
      );
    await tx.insert(projectTaskOperationTable).values({
      id,
      projectId,
      workspaceId,
      userId,
      bodyHash,
      intent: request,
      snapshot,
      result,
      expiresAt,
    });
    return result;
  });
}
