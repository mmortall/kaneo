import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { labelTable, projectTable, taskTable } from "../../database/schema";

async function exportTasks(
  projectId: string,
  page?: { limit: number; cursor?: string },
) {
  const project = await db.query.projectTable.findFirst({
    where: eq(projectTable.id, projectId),
  });

  if (!project) {
    throw new HTTPException(404, {
      message: "Project not found",
    });
  }

  const query = db
    .select({
      id: taskTable.id,
      version: taskTable.version,
      projectId: taskTable.projectId,
      workItemType: taskTable.workItemType,
      title: taskTable.title,
      number: taskTable.number,
      description: taskTable.description,
      goal: taskTable.goal,
      acceptanceCriteria: taskTable.acceptanceCriteria,
      blockedReason: taskTable.blockedReason,
      unblockPolicy: taskTable.unblockPolicy,
      completionSummary: taskTable.completionSummary,
      taskCategory: taskTable.taskCategory,
      strategyHorizons: taskTable.strategyHorizons,
      status: taskTable.status,
      priority: taskTable.priority,
      startDate: taskTable.startDate,
      dueDate: taskTable.dueDate,
      position: taskTable.position,
      createdAt: taskTable.createdAt,
      userId: taskTable.userId,
    })
    .from(taskTable)
    .where(
      and(
        eq(taskTable.projectId, projectId),
        page?.cursor ? gt(taskTable.id, page.cursor) : undefined,
      ),
    )
    .orderBy(page ? asc(taskTable.id) : asc(taskTable.position));
  const selected = await (page ? query.limit(page.limit + 1) : query);
  const hasMore = page !== undefined && selected.length > page.limit;
  const tasks = page ? selected.slice(0, page.limit) : selected;

  const taskIds = tasks.map((task) => task.id);

  const labelsData =
    taskIds.length > 0
      ? await db
          .select({
            id: labelTable.id,
            name: labelTable.name,
            color: labelTable.color,
            taskId: labelTable.taskId,
          })
          .from(labelTable)
          .where(inArray(labelTable.taskId, taskIds))
      : [];

  const taskLabelsMap = new Map<
    string,
    Array<{ name: string; color: string }>
  >();
  for (const label of labelsData) {
    if (label.taskId) {
      if (!taskLabelsMap.has(label.taskId)) {
        taskLabelsMap.set(label.taskId, []);
      }
      taskLabelsMap.get(label.taskId)?.push({
        name: label.name,
        color: label.color,
      });
    }
  }

  return {
    ...(page
      ? {
          pagination: {
            limit: page.limit,
            nextCursor: hasMore ? (tasks[tasks.length - 1]?.id ?? null) : null,
          },
        }
      : {}),
    project: {
      name: project.name,
      slug: project.slug,
      description: project.description,
      exportedAt: new Date().toISOString(),
    },
    tasks: tasks.map((task) => ({
      ...(page
        ? {
            id: task.id,
            version: task.version,
            projectId: task.projectId,
            number: task.number,
            workItemType: task.workItemType,
            position: task.position,
            createdAt: task.createdAt,
          }
        : {}),
      title: task.title,
      description: task.description || "",
      goal: task.goal,
      acceptanceCriteria: task.acceptanceCriteria,
      blockedReason: task.blockedReason,
      unblockPolicy: task.unblockPolicy,
      completionSummary: task.completionSummary,
      taskCategory: task.taskCategory,
      strategyHorizons: task.strategyHorizons,
      status: task.status,
      priority: page ? task.priority : task.priority || "low",
      dueDate: task.dueDate ? new Date(task.dueDate).toISOString() : null,
      startDate: task.startDate ? new Date(task.startDate).toISOString() : null,
      userId: task.userId || null,
      labels: taskLabelsMap.get(task.id) || [],
    })),
  };
}

export default exportTasks;
