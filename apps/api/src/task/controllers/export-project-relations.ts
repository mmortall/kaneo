import { and, asc, eq, gt, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import db from "../../database";
import {
  projectTable,
  taskRelationTable,
  taskTable,
} from "../../database/schema";

/** Export each project edge once, only when both endpoints are authorized. */
export default async function exportProjectRelations(
  projectId: string,
  workspaceId: string,
  page: { limit: number; cursor?: string },
) {
  const source = alias(taskTable, "export_relation_source");
  const target = alias(taskTable, "export_relation_target");
  const sourceProject = alias(projectTable, "export_relation_source_project");
  const targetProject = alias(projectTable, "export_relation_target_project");
  const selected = await db
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
        or(eq(source.projectId, projectId), eq(target.projectId, projectId)),
        eq(sourceProject.workspaceId, workspaceId),
        eq(targetProject.workspaceId, workspaceId),
        page.cursor ? gt(taskRelationTable.id, page.cursor) : undefined,
      ),
    )
    .orderBy(asc(taskRelationTable.id))
    .limit(page.limit + 1);
  const relations = selected.slice(0, page.limit);
  return {
    relations,
    pagination: {
      limit: page.limit,
      nextCursor:
        selected.length > page.limit
          ? (relations[relations.length - 1]?.id ?? null)
          : null,
    },
  };
}
