import { createHash } from "node:crypto";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  projectTable,
  taskOperationTable,
  taskRelationTable,
  taskTable,
} from "../../database/schema";
import { publishEvent } from "../../events";
import { assertSubtaskRelationAllowed } from "../work-item-hierarchy";

type RelationInput = {
  sourceTaskId: string;
  targetTaskId: string;
  relationType: string;
  userId: string;
  workspaceId: string;
  idempotencyKey?: string;
};

async function createTaskRelation(input: RelationInput) {
  const {
    sourceTaskId,
    targetTaskId,
    relationType,
    userId,
    workspaceId,
    idempotencyKey,
  } = input;
  if (sourceTaskId === targetTaskId)
    throw new HTTPException(400, {
      message: "Cannot create a relation between a task and itself",
    });
  if (idempotencyKey && !/^[\w:.-]{1,128}$/.test(idempotencyKey))
    throw new HTTPException(400, { message: "Invalid Idempotency-Key" });
  const operationId = idempotencyKey
    ? createHash("sha256")
        .update(`relation:create:${userId}:${sourceTaskId}:${idempotencyKey}`)
        .digest("hex")
    : undefined;
  const bodyHash = createHash("sha256")
    .update(JSON.stringify({ sourceTaskId, targetTaskId, relationType }))
    .digest("hex");
  let created = false;
  let sourceProjectId = "";
  const relation = await db.transaction(async (tx) => {
    const initial = await tx
      .select({ id: taskTable.id, projectId: taskTable.projectId })
      .from(taskTable)
      .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
      .where(
        and(
          inArray(taskTable.id, [sourceTaskId, targetTaskId]),
          eq(projectTable.workspaceId, workspaceId),
        ),
      );
    if (!initial.some((task) => task.id === sourceTaskId))
      throw new HTTPException(404, { message: "Source task not found" });
    if (!initial.some((task) => task.id === targetTaskId))
      throw new HTTPException(404, { message: "Target task not found" });
    const projectIds = [
      ...new Set(initial.map((task) => task.projectId)),
    ].sort();
    // Match managed ensure's project-before-task order; canonical order prevents reverse-pair deadlocks.
    const projects = await tx
      .select({ id: projectTable.id, workspaceId: projectTable.workspaceId })
      .from(projectTable)
      .where(inArray(projectTable.id, projectIds))
      .orderBy(asc(projectTable.id))
      .for("update");
    if (
      projects.length !== projectIds.length ||
      projects.some((project) => project.workspaceId !== workspaceId)
    ) {
      throw new HTTPException(404, { message: "Task workspace not found" });
    }
    const tasks = await tx
      .select()
      .from(taskTable)
      .where(inArray(taskTable.id, [sourceTaskId, targetTaskId]))
      .orderBy(asc(taskTable.id))
      .for("update");
    const source = tasks.find((task) => task.id === sourceTaskId);
    const target = tasks.find((task) => task.id === targetTaskId);
    if (!source || !target)
      throw new HTTPException(404, { message: "Task not found" });
    if (
      tasks.some(
        (task) =>
          initial.find((previous) => previous.id === task.id)?.projectId !==
          task.projectId,
      )
    ) {
      throw new HTTPException(409, {
        message:
          "Task changed during relation validation; reconcile before retrying",
      });
    }
    sourceProjectId = source.projectId;
    if (operationId) {
      const [operation] = await tx
        .select()
        .from(taskOperationTable)
        .where(eq(taskOperationTable.id, operationId));
      if (operation) {
        if (operation.bodyHash !== bodyHash)
          throw new HTTPException(409, {
            message: "Idempotency key reused with different payload",
          });
        return operation.result as typeof taskRelationTable.$inferSelect;
      }
    }
    const [existing] = await tx
      .select()
      .from(taskRelationTable)
      .where(
        and(
          eq(taskRelationTable.relationType, relationType),
          or(
            and(
              eq(taskRelationTable.sourceTaskId, sourceTaskId),
              eq(taskRelationTable.targetTaskId, targetTaskId),
            ),
            and(
              eq(taskRelationTable.sourceTaskId, targetTaskId),
              eq(taskRelationTable.targetTaskId, sourceTaskId),
            ),
          ),
        ),
      )
      .limit(1);
    if (existing && !operationId)
      throw new HTTPException(409, { message: "This relation already exists" });
    if (
      existing &&
      relationType !== "related" &&
      existing.sourceTaskId !== sourceTaskId
    ) {
      throw new HTTPException(409, {
        message: "Existing directed relation points in opposite direction",
      });
    }
    let result = existing;
    if (!result) {
      if (relationType === "subtask")
        await assertSubtaskRelationAllowed(source, target, tx);
      [result] = await tx
        .insert(taskRelationTable)
        .values({ sourceTaskId, targetTaskId, relationType })
        .onConflictDoNothing()
        .returning();
      if (!result)
        throw new HTTPException(409, {
          message:
            "Relation or hierarchy parent changed; reconcile before retrying",
        });
      // Relation changes invalidate earlier hierarchy/type validation by legacy CAS writers.
      await tx
        .update(taskTable)
        .set({ updatedAt: new Date() })
        .where(inArray(taskTable.id, [sourceTaskId, targetTaskId]));
      created = true;
    }
    if (operationId)
      await tx
        .insert(taskOperationTable)
        .values({ id: operationId, taskId: sourceTaskId, bodyHash, result });
    return result;
  });
  if (created)
    await publishEvent("task-relation.created", {
      ...relation,
      taskId: sourceTaskId,
      projectId: sourceProjectId,
      userId,
    });
  return relation;
}

export default createTaskRelation;
