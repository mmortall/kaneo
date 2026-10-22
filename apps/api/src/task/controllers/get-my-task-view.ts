import { and, asc, count, eq, inArray, isNull, or, sql } from "drizzle-orm";
import db from "../../database";
import {
  columnTable,
  projectTable,
  taskTable,
  userTable,
} from "../../database/schema";
import type { TaskCategory } from "../task-category";
import type { TaskHorizon } from "../task-horizon";
import { getTaskSelection } from "../task-selection";

/** Select one workspace-wide task page before fetching project summaries. */
export default async function getMyTaskView(
  workspaceId: string,
  userId: string,
  options: {
    page: number;
    limit: number;
    category: TaskCategory;
    horizon?: TaskHorizon;
  },
) {
  const base = and(
    eq(projectTable.workspaceId, workspaceId),
    isNull(projectTable.archivedAt),
    eq(taskTable.userId, userId),
    or(
      eq(taskTable.status, "blocked"),
      sql`EXISTS (SELECT 1 FROM ${columnTable} WHERE ${columnTable.projectId} = ${taskTable.projectId} AND ${columnTable.slug} = ${taskTable.status})`,
    ),
  );
  const horizon = options.horizon
    ? sql`${options.horizon} = ANY(${taskTable.strategyHorizons})`
    : sql`true`;
  const counts = await db
    .select({
      category: taskTable.taskCategory,
      all: count(),
      matching: sql<number>`count(*) FILTER (WHERE ${horizon})`,
      todo: sql<number>`count(*) FILTER (WHERE ${horizon} AND ${taskTable.status} = 'to-do')`,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(base)
    .groupBy(taskTable.taskCategory);
  const todoByCategory: Record<TaskCategory, number> = {
    live_implementation: 0,
    research: 0,
    agent_blocker: 0,
  };
  let total = 0;
  let allCategoriesTotal = 0;
  let categoryAllHorizonsTotal = 0;
  for (const row of counts) {
    todoByCategory[row.category] = Number(row.todo);
    allCategoriesTotal += Number(row.matching);
    if (row.category === options.category) {
      total = Number(row.matching);
      categoryAllHorizonsTotal = Number(row.all);
    }
  }
  const [projectsCount] = await db
    .select({ count: count() })
    .from(projectTable)
    .where(
      and(
        eq(projectTable.workspaceId, workspaceId),
        isNull(projectTable.archivedAt),
      ),
    );
  const selected = await db
    .select({
      task: getTaskSelection(true),
      project: {
        id: projectTable.id,
        name: projectTable.name,
        slug: projectTable.slug,
        icon: projectTable.icon,
        description: projectTable.description,
        isPublic: projectTable.isPublic,
        workspaceId: projectTable.workspaceId,
      },
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .leftJoin(userTable, eq(taskTable.userId, userTable.id))
    .where(and(base, horizon, eq(taskTable.taskCategory, options.category)))
    .orderBy(
      asc(taskTable.projectId),
      asc(taskTable.position),
      asc(taskTable.id),
    )
    .limit(options.limit)
    .offset((options.page - 1) * options.limit);
  const projectIds = [...new Set(selected.map((row) => row.project.id))];
  const columns = projectIds.length
    ? await db
        .select()
        .from(columnTable)
        .where(inArray(columnTable.projectId, projectIds))
        .orderBy(asc(columnTable.position), asc(columnTable.id))
    : [];
  // One batched metadata query regardless of number of selected projects.
  const projects = projectIds.map((id) => {
    const rows = selected.filter((row) => row.project.id === id);
    const tasks = rows.map((row) => row.task);
    return {
      ...rows[0]!.project,
      columns: columns
        .filter((column) => column.projectId === id)
        .map((column) => ({
          id: column.slug,
          slug: column.slug,
          name: column.name,
          icon: column.icon,
          isFinal: column.isFinal,
          tasks: tasks.filter((task) => task.status === column.slug),
        })),
      blockedTasks: tasks.filter((task) => task.status === "blocked"),
      plannedTasks: [],
      archivedTasks: [],
    };
  });
  const hasMore = options.page * options.limit < total;
  return {
    projects,
    counts: {
      total,
      allCategoriesTotal,
      categoryAllHorizonsTotal,
      todoByCategory,
      projectCount: Number(projectsCount?.count ?? 0),
    },
    pagination: {
      page: options.page,
      pageSize: options.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / options.limit)),
      hasMore,
      nextPage: hasMore ? options.page + 1 : null,
    },
  };
}
