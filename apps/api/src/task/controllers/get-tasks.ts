import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  lte,
  type SQL,
  sql,
} from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  columnTable,
  externalLinkTable,
  labelTable,
  projectTable,
  taskTable,
  userTable,
} from "../../database/schema";
import type { TaskCategory } from "../task-category";
import { getTaskSelection } from "../task-selection";
import { type TaskViewFilter, taskViewConditions } from "../task-view-filter";

type GetTasksOptions = {
  view?: TaskViewFilter;
  summary?: boolean;
  includeTotal?: boolean;
  assigneeId?: string;
  dueAfter?: string;
  dueBefore?: string;
  limit?: number;
  page?: number;
  priority?: string;
  workItemType?: "task" | "epic" | "sub_epic";
  taskCategory?: TaskCategory;
  sortBy?:
    | "createdAt"
    | "priority"
    | "dueDate"
    | "position"
    | "title"
    | "number"
    | "scheduleStart";
  sortOrder?: "asc" | "desc";
  status?: string;
  agentReadyOnly?: boolean;
  unblockPolicy?: string;
};

const priorityCaseExpr = sql<number>`CASE
  WHEN ${taskTable.priority} = 'urgent' THEN 4
  WHEN ${taskTable.priority} = 'high' THEN 3
  WHEN ${taskTable.priority} = 'medium' THEN 2
  WHEN ${taskTable.priority} = 'low' THEN 1
  ELSE 0
END`;

function buildOrderBy(
  sortBy: GetTasksOptions["sortBy"],
  sortOrder: GetTasksOptions["sortOrder"],
): SQL {
  const direction = sortOrder === "desc" ? desc : asc;

  switch (sortBy) {
    case "scheduleStart":
      return direction(
        sql`LEAST(${taskTable.startDate}, ${taskTable.dueDate})`,
      );
    case "createdAt":
      return direction(taskTable.createdAt);
    case "priority":
      return direction(priorityCaseExpr);
    case "dueDate":
      return direction(taskTable.dueDate);
    case "title":
      return direction(taskTable.title);
    case "number":
      return direction(taskTable.number);
    default:
      return direction(taskTable.position);
  }
}

async function getTasks(projectId: string, options: GetTasksOptions = {}) {
  const project = await db.query.projectTable.findFirst({
    where: eq(projectTable.id, projectId),
    with: {
      columns: { orderBy: [asc(columnTable.position)] },
    },
  });

  if (!project) {
    throw new HTTPException(404, {
      message: "Project not found",
    });
  }

  const conditions = [eq(taskTable.projectId, projectId)];
  if (options.view)
    conditions.push(...taskViewConditions(options.view, project.slug));

  if (options.status) {
    conditions.push(eq(taskTable.status, options.status));
  }

  if (options.priority) {
    conditions.push(eq(taskTable.priority, options.priority));
  }

  if (options.workItemType) {
    conditions.push(eq(taskTable.workItemType, options.workItemType));
  }

  if (options.taskCategory) {
    conditions.push(eq(taskTable.taskCategory, options.taskCategory));
  }

  if (options.assigneeId) {
    conditions.push(eq(taskTable.userId, options.assigneeId));
  }

  if (options.dueBefore) {
    conditions.push(lte(taskTable.dueDate, new Date(options.dueBefore)));
  }

  if (options.dueAfter) {
    conditions.push(gte(taskTable.dueDate, new Date(options.dueAfter)));
  }

  if (options.agentReadyOnly) {
    conditions.push(
      sql`btrim(coalesce(${taskTable.goal}, '')) <> '' AND btrim(coalesce(${taskTable.acceptanceCriteria}, '')) <> ''`,
    );
  }

  if (options.unblockPolicy) {
    conditions.push(eq(taskTable.unblockPolicy, options.unblockPolicy));
  }

  const whereClause = and(...conditions);
  const usePagination = options.page != null || options.limit != null;
  const page = options.page && options.page > 0 ? options.page : 1;
  const pageSize =
    options.limit && options.limit > 0 ? Math.min(options.limit, 100) : 50;
  const offset = (page - 1) * pageSize;

  const orderByClause = buildOrderBy(
    options.sortBy ?? "position",
    options.sortOrder ?? "asc",
  );

  const includeTotal = options.includeTotal ?? !options.summary;
  let total: number | null = null;
  let countsByStatus: Record<string, number> | undefined;
  let scheduleBounds: { start: string | null; end: string | null } | undefined;
  if (options.view) {
    const counts = await db
      .select({
        status: taskTable.status,
        count: sql<number>`count(*)`,
        ...(options.view.scheduledOnly
          ? {
              start: sql<
                string | null
              >`to_char(min(LEAST(${taskTable.startDate}, ${taskTable.dueDate})), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
              end: sql<
                string | null
              >`to_char(max(GREATEST(${taskTable.startDate}, ${taskTable.dueDate})), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
            }
          : {}),
      })
      .from(taskTable)
      .where(whereClause)
      .groupBy(taskTable.status);
    countsByStatus = Object.fromEntries(
      counts.map((row) => [row.status, Number(row.count)]),
    );
    total = counts.reduce((sum, row) => sum + Number(row.count), 0);
    if (options.view.scheduledOnly) {
      const starts = counts
        .flatMap((row) => (row.start ? [row.start] : []))
        .sort();
      const ends = counts.flatMap((row) => (row.end ? [row.end] : [])).sort();
      scheduleBounds = { start: starts[0] ?? null, end: ends.at(-1) ?? null };
    }
  } else if (usePagination && includeTotal) {
    const [taskCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(taskTable)
      .where(whereClause);
    total = Number(taskCount?.count ?? 0);
  }

  const taskSelection = getTaskSelection(options.summary);

  const query = db
    .select(taskSelection)
    .from(taskTable)
    .leftJoin(userTable, eq(taskTable.userId, userTable.id))
    .where(whereClause)
    .orderBy(orderByClause, asc(taskTable.id));

  const selectedTasks = usePagination
    ? await query.limit(pageSize + (includeTotal ? 0 : 1)).offset(offset)
    : await query;
  const hasMore =
    usePagination &&
    (total !== null
      ? offset + pageSize < total
      : selectedTasks.length > pageSize);
  const paginatedTasks = usePagination
    ? selectedTasks.slice(0, pageSize)
    : selectedTasks;
  if (!usePagination) total = selectedTasks.length;

  const taskIds = paginatedTasks.map((task) => task.id);

  // At most two independent enrichment queries; pool configuration stays unchanged.
  const [labelsData, externalLinksData] = await Promise.all([
    taskIds.length > 0
      ? db
          .select({
            id: labelTable.id,
            name: labelTable.name,
            color: labelTable.color,
            taskId: labelTable.taskId,
          })
          .from(labelTable)
          .where(inArray(labelTable.taskId, taskIds))
      : Promise.resolve([]),
    taskIds.length > 0
      ? db
          .select()
          .from(externalLinkTable)
          .where(inArray(externalLinkTable.taskId, taskIds))
      : Promise.resolve([]),
  ]);

  const taskLabelsMap = new Map<
    string,
    Array<{ id: string; name: string; color: string }>
  >();
  for (const label of labelsData) {
    if (label.taskId) {
      if (!taskLabelsMap.has(label.taskId)) {
        taskLabelsMap.set(label.taskId, []);
      }
      taskLabelsMap.get(label.taskId)?.push({
        id: label.id,
        name: label.name,
        color: label.color,
      });
    }
  }

  const taskExternalLinksMap = new Map<
    string,
    Array<{
      id: string;
      taskId: string;
      integrationId: string;
      resourceType: string;
      externalId: string;
      url: string;
      title: string | null;
      metadata: Record<string, unknown> | null;
    }>
  >();
  for (const externalLink of externalLinksData) {
    if (!taskExternalLinksMap.has(externalLink.taskId)) {
      taskExternalLinksMap.set(externalLink.taskId, []);
    }
    taskExternalLinksMap.get(externalLink.taskId)?.push({
      ...externalLink,
      metadata: externalLink.metadata
        ? JSON.parse(externalLink.metadata)
        : null,
    });
  }

  const columns = project.columns.map((column) => ({
    id: column.slug,
    slug: column.slug,
    name: column.name,
    icon: column.icon,
    isFinal: column.isFinal,
    tasks: paginatedTasks
      .filter((task) => task.status === column.slug)
      .map((task) => ({
        ...task,
        labels: taskLabelsMap.get(task.id) || [],
        externalLinks: taskExternalLinksMap.get(task.id) || [],
      })),
  }));

  const archivedTasks = paginatedTasks
    .filter((task) => task.status === "archived")
    .map((task) => ({
      ...task,
      labels: taskLabelsMap.get(task.id) || [],
      externalLinks: taskExternalLinksMap.get(task.id) || [],
    }));

  const plannedTasks = paginatedTasks
    .filter((task) => task.status === "planned")
    .map((task) => ({
      ...task,
      labels: taskLabelsMap.get(task.id) || [],
      externalLinks: taskExternalLinksMap.get(task.id) || [],
    }));

  const blockedTasks = paginatedTasks
    .filter((task) => task.status === "blocked")
    .map((task) => ({
      ...task,
      labels: taskLabelsMap.get(task.id) || [],
      externalLinks: taskExternalLinksMap.get(task.id) || [],
    }));

  return {
    data: {
      id: project.id,
      name: project.name,
      slug: project.slug,
      icon: project.icon,
      description: project.description,
      isPublic: project.isPublic,
      workspaceId: project.workspaceId,
      columns,
      archivedTasks,
      plannedTasks,
      blockedTasks,
      ...(countsByStatus ? { countsByStatus } : {}),
      ...(scheduleBounds ? { scheduleBounds } : {}),
    },
    pagination: usePagination
      ? {
          total,
          page,
          pageSize,
          totalPages:
            total === null ? null : Math.max(1, Math.ceil(total / pageSize)),
          hasMore,
          nextPage: hasMore ? page + 1 : null,
        }
      : {
          total,
          page: 1,
          pageSize: total,
          totalPages: 1,
        },
  };
}

export default getTasks;
