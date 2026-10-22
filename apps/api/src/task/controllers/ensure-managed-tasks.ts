import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  columnTable,
  projectTable,
  taskRelationTable,
  taskTable,
} from "../../database/schema";
import { publishEvent } from "../../events";
import { assertSubtaskRelationAllowed } from "../../task-relation/work-item-hierarchy";
import { assertTaskWorkflowPolicy } from "../task-workflow-policy";
import { claimTaskNumber } from "./claim-task-numbers";

export type ManagedSpec = {
  key: string;
  title: string;
  description: string;
  goal: string;
  acceptanceCriteria: string;
  workItemType: "epic" | "sub_epic" | "task";
};

type CandidateReader = Pick<
  Parameters<Parameters<typeof db.transaction>[0]>[0],
  "select"
>;

export async function resolveManagedCandidate(
  tx: CandidateReader,
  projectId: string,
  item: ManagedSpec,
) {
  const scope = eq(taskTable.projectId, projectId);
  let [task] = await tx
    .select()
    .from(taskTable)
    .where(and(scope, eq(taskTable.managedKey, item.key)));
  const indexed = Boolean(task);
  if (!task) {
    // Markers left unindexed by migration are collisions or legacy records.
    const matches = await tx
      .select()
      .from(taskTable)
      .where(
        and(
          scope,
          sql`${taskTable.description} LIKE ${`%"key":"${item.key.replace(/[\\%_]/g, "\\$&")}"%`}`,
        ),
      )
      .limit(2);
    if (matches.length > 1)
      throw new HTTPException(409, {
        message: "Duplicate managed key requires reconciliation",
      });
    task = matches[0];
    if (!task) {
      const titles = await tx
        .select()
        .from(taskTable)
        .where(
          and(
            scope,
            eq(taskTable.title, item.title),
            eq(taskTable.workItemType, item.workItemType),
            sql`${taskTable.status} <> 'archived' AND ${taskTable.managedKey} IS NULL AND coalesce(${taskTable.description}, '') NOT LIKE '%<!-- kaneo-managed:%'`,
          ),
        )
        .limit(2);
      if (titles.length > 1)
        throw new HTTPException(409, {
          message: "Ambiguous managed title requires reconciliation",
        });
      task = titles[0];
    }
  }
  return { task, adopt: Boolean(task) && !indexed };
}

export default async function ensureManagedTasks(
  projectId: string,
  items: ManagedSpec[],
  userId: string,
) {
  const created: (typeof taskTable.$inferSelect)[] = [];
  const result = await db.transaction(async (tx) => {
    const [project] = await tx
      .select()
      .from(projectTable)
      .where(eq(projectTable.id, projectId))
      .for("update");
    if (!project)
      throw new HTTPException(404, { message: "Project not found" });
    const columns = await tx
      .select()
      .from(columnTable)
      .where(eq(columnTable.projectId, projectId));
    const tasks: (typeof taskTable.$inferSelect)[] = [];
    const actions: string[] = [];
    const candidates = [];
    for (const item of items)
      candidates.push(await resolveManagedCandidate(tx, projectId, item));
    const existingIds = candidates.flatMap(({ task }) =>
      task ? [task.id] : [],
    );
    const locked = existingIds.length
      ? await tx
          .select()
          .from(taskTable)
          .where(inArray(taskTable.id, existingIds))
          .orderBy(asc(taskTable.id))
          .for("update")
      : [];
    const lockedById = new Map(locked.map((task) => [task.id, task]));
    for (const [index, item] of items.entries()) {
      const scope = eq(taskTable.projectId, projectId);
      const candidate = candidates[index]!;
      let task = candidate.task ? lockedById.get(candidate.task.id) : undefined;
      if (
        candidate.task &&
        (!task ||
          task.projectId !== projectId ||
          task.version !== candidate.task.version)
      ) {
        throw new HTTPException(409, {
          message: "Managed candidate changed; retry lookup",
        });
      }
      if (candidate.adopt) {
        if (task) {
          const marker = item.description.match(
            /<!-- kaneo-managed:[\s\S]*?-->/,
          )?.[0];
          const description = task.description ?? "";
          const active = !["done", "archived", "blocked"].includes(task.status);
          [task] = await tx
            .update(taskTable)
            .set({
              managedKey: item.key,
              description:
                marker && !description.includes("<!-- kaneo-managed:")
                  ? `${description}${description ? "\n\n" : ""}${marker}`
                  : task.description,
              ...(active
                ? {
                    goal: task.goal?.trim() ? task.goal : item.goal,
                    acceptanceCriteria: task.acceptanceCriteria?.trim()
                      ? task.acceptanceCriteria
                      : item.acceptanceCriteria,
                  }
                : {}),
            })
            .where(eq(taskTable.id, task.id))
            .returning();
        }
      }
      if (task) {
        if (task.workItemType !== item.workItemType)
          throw new HTTPException(409, {
            message: "Managed task type mismatch",
          });
        actions.push("reuse");
      } else {
        const status = index === 2 ? "in-progress" : "to-do";
        const column = columns.find((c) => c.slug === status);
        if (!column)
          throw new HTTPException(409, {
            message: `Project lacks ${status} column`,
          });
        assertTaskWorkflowPolicy({
          isAiCaller: true,
          nextStatus: status,
          fields: item,
        });
        const [position] = await tx
          .select({ value: max(taskTable.position) })
          .from(taskTable)
          .where(and(scope, eq(taskTable.status, status)));
        [task] = await tx
          .insert(taskTable)
          .values({
            projectId,
            managedKey: item.key,
            title: item.title,
            description: item.description,
            goal: item.goal,
            acceptanceCriteria: item.acceptanceCriteria,
            workItemType: item.workItemType,
            status,
            columnId: column.id,
            priority: index === 0 ? "high" : "medium",
            position: (position?.value ?? 0) + 1,
            number: await claimTaskNumber(projectId, tx),
          })
          .returning();
        if (!task)
          throw new HTTPException(500, {
            message: "Managed task insert failed",
          });
        created.push(task);
        actions.push("create");
      }
      if (index > 0) {
        if (!task)
          throw new HTTPException(500, { message: "Managed task missing" });
        const expectedParent = tasks[index - 1];
        if (!expectedParent)
          throw new HTTPException(500, { message: "Managed parent missing" });
        const parents = await tx
          .select()
          .from(taskRelationTable)
          .where(
            and(
              eq(taskRelationTable.targetTaskId, task.id),
              eq(taskRelationTable.relationType, "subtask"),
            ),
          )
          .limit(2);
        const parent = parents[0];
        if (
          parents.length > 1 ||
          (parent && parent.sourceTaskId !== expectedParent.id)
        ) {
          throw new HTTPException(409, {
            message:
              "Existing hierarchy differs; explicit reconciliation required",
          });
        }
        if (!parent) {
          await assertSubtaskRelationAllowed(expectedParent, task, tx);
          await tx.insert(taskRelationTable).values({
            sourceTaskId: expectedParent.id,
            targetTaskId: task.id,
            relationType: "subtask",
          });
          // Invalidate type validation performed before this new hierarchy edge.
          await tx
            .update(taskTable)
            .set({ updatedAt: new Date() })
            .where(inArray(taskTable.id, [expectedParent.id, task.id]));
        }
      }
      if (!task)
        throw new HTTPException(500, { message: "Managed task missing" });
      tasks.push(task);
    }
    const refreshed = await tx
      .select()
      .from(taskTable)
      .where(
        inArray(
          taskTable.id,
          tasks.map((task) => task.id),
        ),
      );
    const refreshedById = new Map(refreshed.map((task) => [task.id, task]));
    return { tasks: tasks.map((task) => refreshedById.get(task.id)!), actions };
  });
  for (const task of created)
    await publishEvent("task.created", {
      ...result.tasks.find((current) => current.id === task.id),
      taskId: task.id,
      currentUserId: userId,
      type: "created",
      content: null,
    });
  return result;
}
