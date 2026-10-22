import { and, asc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  projectTable,
  taskRelationTable,
  taskTable,
} from "../../database/schema";

/** Return one authorized snapshot with bounded relation pages and task prose. */
export default async function getTaskContext(
  taskId: string,
  workspaceId: string,
  page = 1,
  limit = 25,
) {
  return db.transaction(
    async (tx) => {
      const [selected] = await tx
        .select({ task: taskTable })
        .from(taskTable)
        .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
        .where(
          and(
            eq(taskTable.id, taskId),
            eq(projectTable.workspaceId, workspaceId),
          ),
        );
      if (!selected)
        throw new HTTPException(404, { message: "Task not found" });
      const source = alias(taskTable, "context_source");
      const target = alias(taskTable, "context_target");
      const sourceProject = alias(projectTable, "context_source_project");
      const targetProject = alias(projectTable, "context_target_project");
      const relationQuery = (condition: SQL) =>
        tx
          .select({
            id: taskRelationTable.id,
            sourceTaskId: taskRelationTable.sourceTaskId,
            targetTaskId: taskRelationTable.targetTaskId,
            relationType: taskRelationTable.relationType,
            createdAt: taskRelationTable.createdAt,
          })
          .from(taskRelationTable)
          .innerJoin(source, eq(taskRelationTable.sourceTaskId, source.id))
          .innerJoin(target, eq(taskRelationTable.targetTaskId, target.id))
          .innerJoin(sourceProject, eq(source.projectId, sourceProject.id))
          .innerJoin(targetProject, eq(target.projectId, targetProject.id))
          .where(
            and(
              condition,
              eq(sourceProject.workspaceId, workspaceId),
              eq(targetProject.workspaceId, workspaceId),
            ),
          )
          .orderBy(asc(taskRelationTable.id));
      const batch = await relationQuery(
        or(
          eq(taskRelationTable.sourceTaskId, taskId),
          eq(taskRelationTable.targetTaskId, taskId),
        )!,
      )
        .limit(limit + 1)
        .offset((page - 1) * limit);
      const relations = batch.slice(0, limit);
      const ancestors: string[] = [];
      const seen = new Set([taskId]);
      let current = taskId;
      while (true) {
        const parents = await relationQuery(
          and(
            eq(taskRelationTable.targetTaskId, current),
            eq(taskRelationTable.relationType, "subtask"),
          )!,
        ).limit(2);
        if (!parents.length) break;
        if (parents.length > 1)
          throw new HTTPException(409, {
            message: "Task context has multiple hierarchy parents",
          });
        const parent = parents[0]!.sourceTaskId;
        if (seen.has(parent))
          throw new HTTPException(409, {
            message: "Task context hierarchy is cyclic",
          });
        if (ancestors.length >= 32)
          throw new HTTPException(409, {
            message: "Task context exceeds 32 ancestors",
          });
        seen.add(parent);
        ancestors.push(parent);
        current = parent;
      }
      const linkedIds = [
        ...new Set([
          ...ancestors,
          ...relations.map((relation) =>
            relation.sourceTaskId === taskId
              ? relation.targetTaskId
              : relation.sourceTaskId,
          ),
        ]),
      ].filter((id) => id !== taskId);
      const linkedRows = linkedIds.length
        ? await tx
            .select({
              id: taskTable.id,
              version: taskTable.version,
              projectId: taskTable.projectId,
              title: sql<string>`left(${taskTable.title}, 512)`,
              status: taskTable.status,
              number: taskTable.number,
              priority: taskTable.priority,
              workItemType: taskTable.workItemType,
              taskCategory: taskTable.taskCategory,
              userId: taskTable.userId,
              goal: sql<string | null>`left(${taskTable.goal}, 512)`,
              acceptanceCriteria: sql<
                string | null
              >`left(${taskTable.acceptanceCriteria}, 512)`,
              truncatedFields: {
                title: sql<boolean>`length(${taskTable.title}) > 512`,
                goal: sql<boolean>`length(${taskTable.goal}) > 512`,
                acceptanceCriteria: sql<boolean>`length(${taskTable.acceptanceCriteria}) > 512`,
              },
            })
            .from(taskTable)
            .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
            .where(
              and(
                inArray(taskTable.id, linkedIds),
                eq(projectTable.workspaceId, workspaceId),
              ),
            )
            .orderBy(asc(taskTable.id))
        : [];
      const fields: Record<string, string[]> = {};
      const task = { ...selected.task };
      for (const field of [
        "title",
        "description",
        "goal",
        "acceptanceCriteria",
        "blockedReason",
        "completionSummary",
      ] as const) {
        const value = task[field];
        if (typeof value === "string" && value.length > 4096) {
          task[field] = value.slice(0, 4096);
          fields[taskId] ??= [];
          fields[taskId].push(field);
        }
      }
      const linked = linkedRows.map(({ truncatedFields, ...row }) => {
        const truncated = Object.entries(truncatedFields)
          .filter(([, value]) => value)
          .map(([field]) => field);
        if (truncated.length) fields[row.id] = truncated;
        return row;
      });
      const hasMore = batch.length > limit;
      return {
        task,
        relations,
        parent_ids: ancestors.slice(0, 1),
        ancestor_ids: ancestors,
        child_ids: relations
          .filter(
            (relation) =>
              relation.relationType === "subtask" &&
              relation.sourceTaskId === taskId,
          )
          .map((relation) => relation.targetTaskId),
        related_ids: relations
          .filter((relation) => relation.relationType === "related")
          .map((relation) =>
            relation.sourceTaskId === taskId
              ? relation.targetTaskId
              : relation.sourceTaskId,
          ),
        linked_tasks: linked,
        pagination: {
          page,
          limit,
          hasMore,
          nextPage: hasMore ? page + 1 : null,
        },
        truncation: {
          relations: hasMore || page > 1,
          fields,
          linked_details_omitted: [
            "description",
            "blockedReason",
            "completionSummary",
          ],
        },
        task_detail_path: `/task/${encodeURIComponent(taskId)}`,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
