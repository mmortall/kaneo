import { and, asc, eq, isNull, sql } from "drizzle-orm";
import db from "../../database";
import { labelTable } from "../../database/schema";

export type LabelCatalogueQuery = {
  page: number;
  limit: number;
  scope: "groups" | "definitions";
  search: string;
  exact?: boolean;
};

/** Page label choices without transporting every task's label assignment. */
export default async function getLabelCatalogue(
  workspaceId: string,
  query: LabelCatalogueQuery,
) {
  const where = and(
    eq(labelTable.workspaceId, workspaceId),
    query.scope === "definitions" ? isNull(labelTable.taskId) : undefined,
    query.search.trim()
      ? query.exact
        ? sql`lower(${labelTable.name}) = lower(${query.search.trim()})`
        : sql`strpos(lower(${labelTable.name}), lower(${query.search.trim()})) > 0`
      : undefined,
  );
  return db.transaction(
    async (tx) => {
      const groups = tx
        .select({ name: labelTable.name, color: labelTable.color })
        .from(labelTable)
        .where(where)
        .groupBy(labelTable.name, labelTable.color)
        .as("catalogue_groups");
      const [count] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(groups);
      if (!count) throw new Error("Label catalogue count is unavailable");
      const items = await tx
        .select({
          id: sql<string>`coalesce(min(${labelTable.id}) FILTER (WHERE ${labelTable.taskId} IS NULL), min(${labelTable.id}))`,
          name: labelTable.name,
          color: labelTable.color,
          isWorkspaceLabel: sql<boolean>`bool_or(${labelTable.taskId} IS NULL)`,
        })
        .from(labelTable)
        .where(where)
        .groupBy(labelTable.name, labelTable.color)
        .orderBy(asc(labelTable.name), asc(labelTable.color))
        .limit(query.limit)
        .offset((query.page - 1) * query.limit);
      const totalPages = Math.ceil(count.total / query.limit);
      const hasMore = query.page < totalPages;
      return {
        items,
        pagination: {
          total: count.total,
          page: query.page,
          pageSize: query.limit,
          totalPages,
          hasMore,
          nextPage: hasMore ? query.page + 1 : null,
        },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
