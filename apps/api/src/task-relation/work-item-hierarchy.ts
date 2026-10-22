import { and, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import { taskRelationTable, taskTable } from "../database/schema";

export const WORK_ITEM_TYPES = ["task", "epic", "sub_epic"] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

type WorkItem = {
  id: string;
  projectId: string;
  workItemType: string;
};

export function isAllowedParentChild(parent: string, child: string) {
  return (
    (parent === "epic" && (child === "sub_epic" || child === "task")) ||
    (parent === "sub_epic" && child === "task")
  );
}

function invalidHierarchy(message: string): never {
  throw new HTTPException(409, { message });
}

export async function assertSubtaskRelationAllowed(
  sourceTask: WorkItem,
  targetTask: WorkItem,
  database:
    | typeof db
    | Parameters<Parameters<typeof db.transaction>[0]>[0] = db,
) {
  if (sourceTask.projectId !== targetTask.projectId) {
    invalidHierarchy("Hierarchy items must belong to the same project");
  }

  if (!isAllowedParentChild(sourceTask.workItemType, targetTask.workItemType)) {
    invalidHierarchy(
      "Allowed hierarchy is epic → sub-epic/task and sub-epic → task",
    );
  }

  const [existingParent] = await database
    .select({ id: taskRelationTable.id })
    .from(taskRelationTable)
    .where(
      and(
        eq(taskRelationTable.relationType, "subtask"),
        eq(taskRelationTable.targetTaskId, targetTask.id),
      ),
    )
    .limit(1);

  if (existingParent) {
    invalidHierarchy("A hierarchy item can have only one parent");
  }

  let ancestorId = sourceTask.id;
  const visited = new Set<string>();
  while (ancestorId) {
    if (visited.has(ancestorId) || visited.size >= 32) {
      invalidHierarchy(
        "Existing hierarchy is cyclic or exceeds supported depth",
      );
    }
    visited.add(ancestorId);
    if (ancestorId === targetTask.id) {
      invalidHierarchy("A hierarchy relation cannot create a cycle");
    }
    const [parent] = await database
      .select({ sourceTaskId: taskRelationTable.sourceTaskId })
      .from(taskRelationTable)
      .where(
        and(
          eq(taskRelationTable.relationType, "subtask"),
          eq(taskRelationTable.targetTaskId, ancestorId),
        ),
      )
      .limit(1);
    ancestorId = parent?.sourceTaskId ?? "";
  }
}

export async function assertWorkItemTypeChangeAllowed(
  taskId: string,
  nextType: WorkItemType,
  database:
    | typeof db
    | Parameters<Parameters<typeof db.transaction>[0]>[0] = db,
) {
  const relations = await database
    .select({
      sourceTaskId: taskRelationTable.sourceTaskId,
      targetTaskId: taskRelationTable.targetTaskId,
    })
    .from(taskRelationTable)
    .where(
      and(
        eq(taskRelationTable.relationType, "subtask"),
        eq(taskRelationTable.sourceTaskId, taskId),
      ),
    );

  const parents = await database
    .select({ sourceTaskId: taskRelationTable.sourceTaskId })
    .from(taskRelationTable)
    .where(
      and(
        eq(taskRelationTable.relationType, "subtask"),
        eq(taskRelationTable.targetTaskId, taskId),
      ),
    );

  const relatedIds = [
    ...relations.map((relation) => relation.targetTaskId),
    ...parents.map((relation) => relation.sourceTaskId),
  ];
  const relatedTasks = relatedIds.length
    ? await database
        .select({ id: taskTable.id, workItemType: taskTable.workItemType })
        .from(taskTable)
        .where(inArray(taskTable.id, relatedIds))
    : [];
  const typeById = new Map(
    relatedTasks.map((task) => [task.id, task.workItemType]),
  );

  for (const relation of relations) {
    if (
      !isAllowedParentChild(
        nextType,
        typeById.get(relation.targetTaskId) ?? "task",
      )
    ) {
      invalidHierarchy(
        "New work item type is incompatible with an existing child",
      );
    }
  }
  for (const relation of parents) {
    if (
      !isAllowedParentChild(
        typeById.get(relation.sourceTaskId) ?? "task",
        nextType,
      )
    ) {
      invalidHierarchy("New work item type is incompatible with its parent");
    }
  }
}
