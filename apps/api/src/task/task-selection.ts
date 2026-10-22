import { sql } from "drizzle-orm";
import { taskTable, userTable } from "../database/schema";

/** Shared task projection keeps long prose out of summary SQL results. */
export function getTaskSelection(summary = false) {
  return {
    id: taskTable.id,
    version: taskTable.version,
    title: taskTable.title,
    number: taskTable.number,
    description: summary ? sql<null>`NULL` : taskTable.description,
    goal: summary ? sql<null>`NULL` : taskTable.goal,
    acceptanceCriteria: summary
      ? sql<null>`NULL`
      : taskTable.acceptanceCriteria,
    blockedReason: summary ? sql<null>`NULL` : taskTable.blockedReason,
    unblockPolicy: taskTable.unblockPolicy,
    completionSummary: summary ? sql<null>`NULL` : taskTable.completionSummary,
    status: taskTable.status,
    priority: taskTable.priority,
    workItemType: taskTable.workItemType,
    taskCategory: taskTable.taskCategory,
    strategyHorizons: taskTable.strategyHorizons,
    startDate: taskTable.startDate,
    dueDate: taskTable.dueDate,
    position: taskTable.position,
    createdAt: taskTable.createdAt,
    userId: taskTable.userId,
    assigneeName: userTable.name,
    assigneeId: userTable.id,
    assigneeImage: userTable.image,
    projectId: taskTable.projectId,
  };
}
