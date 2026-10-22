import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  columnTable,
  projectTable,
  taskOperationTable,
  taskTable,
} from "../../database/schema";
import { publishEvent } from "../../events";
import {
  assertTaskWorkflowPolicy,
  isAiTaskCaller,
  resolveTaskWorkflowFields,
  type TaskWorkflowFields,
} from "../task-workflow-policy";
import { VIRTUAL_STATUSES } from "../validate-task-fields";

export type TaskOrder = {
  [Key in keyof TaskWorkflowFields]: Exclude<TaskWorkflowFields[Key], null>;
} & {
  projectId: string;
  expectedVersion: number;
  status: string;
  anchor?: {
    id: string;
    expectedVersion: number;
    placement: "before" | "after";
  };
  unblockNote?: string;
};
type OrderResult = {
  id: string;
  projectId: string;
  status: string;
  position: number | null;
  version: number;
};

function conflict(message: string): never {
  throw new HTTPException(409, {
    res: Response.json({ error: "TASK_CONFLICT", message }, { status: 409 }),
  });
}

/** Order complete destination set atomically, without client-side neighbor writes. */
export default async function orderTask(
  id: string,
  order: TaskOrder,
  userId: string,
  workspaceId: string,
  key: string,
  caller?: string,
) {
  const operationId = createHash("sha256")
    .update(`${userId}:order:${id}:${key}`)
    .digest("hex");
  const bodyHash = createHash("sha256")
    .update(JSON.stringify(order))
    .digest("hex");
  let oldStatus = "";
  let title = "";
  let assigneeId: string | null = null;
  let replayed = false;
  const result = await db.transaction(async (tx) => {
    const [project] = await tx
      .select({ id: projectTable.id })
      .from(projectTable)
      .where(
        and(
          eq(projectTable.id, order.projectId),
          eq(projectTable.workspaceId, workspaceId),
        ),
      )
      .for("update");
    if (!project) conflict("Task project changed; reload before retrying");
    const [operation] = await tx
      .select()
      .from(taskOperationTable)
      .where(eq(taskOperationTable.id, operationId));
    if (operation) {
      if (operation.bodyHash !== bodyHash)
        conflict("Idempotency key reused with different ordering");
      replayed = true;
      return operation.result as OrderResult;
    }
    if (order.anchor?.id === id)
      throw new HTTPException(400, { message: "Task cannot anchor itself" });
    const snapshots = await tx
      .select({
        id: taskTable.id,
        version: taskTable.version,
        status: taskTable.status,
      })
      .from(taskTable)
      .where(
        and(
          eq(taskTable.projectId, order.projectId),
          inArray(taskTable.id, [
            id,
            ...(order.anchor ? [order.anchor.id] : []),
          ]),
        ),
      );
    if (
      snapshots.find((task) => task.id === id)?.version !==
      order.expectedVersion
    )
      conflict("Task changed; reload before reordering");
    if (order.anchor) {
      const snapshot = snapshots.find((task) => task.id === order.anchor!.id);
      if (
        !snapshot ||
        snapshot.version !== order.anchor.expectedVersion ||
        snapshot.status !== order.status
      )
        conflict("Destination task changed; reload before reordering");
    }
    // Lock rows in ID order before taking any individual task lock. Aggregate
    // result stays small even when destination contains thousands of tasks.
    await tx.execute(sql`SELECT count(*) FROM (
      SELECT ${taskTable.id} FROM ${taskTable}
      WHERE ${taskTable.projectId} = ${order.projectId}
        AND (${taskTable.status} = ${order.status} OR ${taskTable.id} = ${id})
      ORDER BY ${taskTable.id} FOR UPDATE
    ) locked`);
    const [current] = await tx
      .select()
      .from(taskTable)
      .where(eq(taskTable.id, id));
    if (!current) throw new HTTPException(404, { message: "Task not found" });
    if (
      current.projectId !== order.projectId ||
      current.version !== order.expectedVersion
    )
      conflict("Task changed; reload before reordering");
    const [column] = await tx
      .select({ id: columnTable.id, isFinal: columnTable.isFinal })
      .from(columnTable)
      .where(
        and(
          eq(columnTable.projectId, order.projectId),
          eq(columnTable.slug, order.status),
        ),
      );
    if (
      !column &&
      !(VIRTUAL_STATUSES as readonly string[]).includes(order.status)
    )
      throw new HTTPException(400, {
        message: "Destination status is not valid for project",
      });
    const workflow = resolveTaskWorkflowFields(current, order.status, order);
    assertTaskWorkflowPolicy({
      isAiCaller: isAiTaskCaller(caller),
      existing: current,
      nextStatus: order.status,
      isFinalStatus: order.status === "done" || column?.isFinal === true,
      fields: {
        ...workflow,
        ...(current.status !== "blocked" && order.status === "blocked"
          ? {
              blockedReason: order.blockedReason,
              unblockPolicy: order.unblockPolicy,
            }
          : {}),
      },
      unblockNote: order.unblockNote,
    });
    if (order.anchor) {
      const [anchor] = await tx
        .select({
          version: taskTable.version,
          projectId: taskTable.projectId,
          status: taskTable.status,
        })
        .from(taskTable)
        .where(eq(taskTable.id, order.anchor.id));
      if (
        !anchor ||
        anchor.projectId !== order.projectId ||
        anchor.status !== order.status ||
        anchor.version !== order.anchor.expectedVersion
      )
        conflict("Destination task changed; reload before reordering");
    }
    const ranked = await tx.execute<{
      rank: string;
      position: number | null;
      previous_position: number | null;
      next_position: number | null;
      previous_id: string | null;
      next_id: string | null;
      null_positions: string;
    }>(sql`WITH ordered AS (
      SELECT ${taskTable.id} AS id, ${taskTable.position} AS position,
        row_number() OVER ordering - 1 AS rank,
        lag(${taskTable.position}) OVER ordering AS previous_position,
        lead(${taskTable.position}) OVER ordering AS next_position,
        lag(${taskTable.id}) OVER ordering AS previous_id,
        lead(${taskTable.id}) OVER ordering AS next_id
      FROM ${taskTable} WHERE ${taskTable.projectId} = ${order.projectId}
        AND ${taskTable.status} = ${order.status} AND ${taskTable.id} <> ${id}
      WINDOW ordering AS (ORDER BY ${taskTable.position}, ${taskTable.id})
    ) ${
      order.anchor
        ? sql`SELECT * FROM ordered WHERE id = ${order.anchor.id}`
        : sql`SELECT count(*) AS rank, max(position) AS position, count(*) FILTER (WHERE position IS NULL) AS null_positions FROM ordered`
    }`);
    const slot = ranked.rows[0];
    if (!slot) conflict("Destination ordering changed; reload before retrying");
    const insertion =
      Number(slot.rank) + (order.anchor?.placement === "after" ? 1 : 0);
    if (
      !Number.isSafeInteger(insertion) ||
      insertion < 0 ||
      insertion > 2147483646
    )
      conflict("Destination ordering changed; reload before retrying");
    let position: number | undefined;
    if (!order.anchor) {
      if (insertion === 0) position = 0;
      else if (Number(slot.null_positions) === 0 && slot.position !== null)
        position = slot.position + 1;
    } else if (slot.position !== null) {
      if (order.anchor.placement === "before") {
        if (!slot.previous_id) position = slot.position - 1;
        else if (
          slot.previous_position !== null &&
          slot.position - slot.previous_position > 1
        )
          position =
            slot.previous_position +
            Math.floor((slot.position - slot.previous_position) / 2);
      } else {
        if (!slot.next_id) position = slot.position + 1;
        else if (
          slot.next_position !== null &&
          slot.next_position - slot.position > 1
        )
          position =
            slot.position +
            Math.floor((slot.next_position - slot.position) / 2);
      }
    }
    if (
      position !== undefined &&
      (position < -2147483648 || position > 2147483647)
    )
      position = undefined;
    // Renumber only changed neighbors. Prose and other fields stay untouched.
    if (position === undefined)
      await tx.execute(sql`WITH ordered AS (
      SELECT ${taskTable.id} AS id, row_number() OVER (ORDER BY ${taskTable.position}, ${taskTable.id}) - 1 AS rank
      FROM ${taskTable} WHERE ${taskTable.projectId} = ${order.projectId}
        AND ${taskTable.status} = ${order.status} AND ${taskTable.id} <> ${id}
    ) UPDATE ${taskTable} AS t
      SET position = (ordered.rank + CASE WHEN ordered.rank >= ${insertion} THEN 1 ELSE 0 END)::integer, updated_at = now()
      FROM ordered WHERE t.id = ordered.id
        AND t.position IS DISTINCT FROM (ordered.rank + CASE WHEN ordered.rank >= ${insertion} THEN 1 ELSE 0 END)::integer`);
    const [updated] = await tx
      .update(taskTable)
      .set({
        status: order.status,
        columnId: column?.id ?? null,
        position: position ?? insertion,
        ...workflow,
      })
      .where(
        and(eq(taskTable.id, id), eq(taskTable.version, order.expectedVersion)),
      )
      .returning();
    if (!updated) conflict("Task changed during reordering");
    oldStatus = current.status;
    title = updated.title;
    assigneeId = updated.userId;
    const snapshot: OrderResult = {
      id: updated.id,
      projectId: updated.projectId,
      status: updated.status,
      position: updated.position,
      version: updated.version,
    };
    await tx
      .insert(taskOperationTable)
      .values({ id: operationId, taskId: id, bodyHash, result: snapshot });
    return snapshot;
  });
  if (!replayed) {
    if (oldStatus !== result.status) {
      await publishEvent("task.status_changed", {
        taskId: id,
        projectId: result.projectId,
        userId,
        oldStatus,
        newStatus: result.status,
        title,
        assigneeId,
        type: "status_changed",
      });
      await publishEvent("task-relation.refresh", {
        projectId: result.projectId,
        userId,
      });
    }
    await publishEvent("task.updated", {
      taskId: id,
      projectId: result.projectId,
      userId,
      title,
      status: result.status,
    });
  }
  return result;
}
