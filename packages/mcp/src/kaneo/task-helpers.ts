const PRIORITIES = ["no-priority", "low", "medium", "high", "urgent"] as const;

export type TaskPriority = (typeof PRIORITIES)[number];
export type WorkItemType = "task" | "epic" | "sub_epic";
export type TaskCategory = "live_implementation" | "research" | "agent_blocker";
export type TaskHorizon =
  | "short"
  | "position"
  | "long_term"
  | "ultra_long_term";

export function isTaskPriority(v: string): v is TaskPriority {
  return (PRIORITIES as readonly string[]).includes(v);
}

export type TaskUpdatePatch = {
  title?: string;
  description?: string | null;
  status?: string;
  priority?: TaskPriority;
  projectId?: string;
  position?: number;
  startDate?: string | null;
  dueDate?: string | null;
  userId?: string | null;
  workItemType?: WorkItemType;
  taskCategory?: TaskCategory;
  strategyHorizons?: TaskHorizon[];
  goal?: string;
  acceptanceCriteria?: string;
  blockedReason?: string;
  unblockPolicy?: "ai_allowed" | "human_required";
  completionSummary?: string;
  unblockNote?: string;
};

/**
 * Builds the JSON body for `PUT /api/task/:id` from an existing task plus a patch.
 */
export function buildFullTaskUpdateBody(
  existing: Record<string, unknown>,
  patch: TaskUpdatePatch,
): Record<string, unknown> {
  const positionRaw = patch.position ?? existing.position;
  const position =
    typeof positionRaw === "number"
      ? positionRaw
      : typeof positionRaw === "string"
        ? Number(positionRaw)
        : Number.NaN;
  if (!Number.isFinite(position)) {
    throw new Error(
      "Cannot update task: missing numeric `position` on existing task.",
    );
  }

  const title =
    patch.title ??
    (typeof existing.title === "string" ? existing.title : undefined);
  if (!title) {
    throw new Error("Cannot update task: missing title.");
  }

  const description =
    patch.description !== undefined
      ? patch.description === null
        ? ""
        : String(patch.description)
      : existing.description == null
        ? ""
        : String(existing.description);

  const status =
    patch.status ??
    (typeof existing.status === "string" ? existing.status : undefined);
  if (!status) {
    throw new Error("Cannot update task: missing status.");
  }

  const priorityRaw =
    patch.priority ??
    (typeof existing.priority === "string" ? existing.priority : undefined);
  if (!priorityRaw || !isTaskPriority(priorityRaw)) {
    throw new Error("Cannot update task: invalid or missing priority.");
  }

  const projectId =
    patch.projectId ??
    (typeof existing.projectId === "string" ? existing.projectId : undefined);
  if (!projectId) {
    throw new Error("Cannot update task: missing projectId.");
  }

  // When patch.userId is explicitly null, we set userId to "" so the API clears assignee; the API
  // treats "" as unassigned (userId || null). When patch.userId is undefined, keep existing.userId
  // unchanged (leave assignee as-is).
  const userId =
    patch.userId !== undefined
      ? patch.userId === null
        ? ""
        : patch.userId
      : typeof existing.userId === "string"
        ? existing.userId
        : undefined;

  const startDate = formatOptionalIso(
    patch.startDate !== undefined ? patch.startDate : existing.startDate,
  );
  const workItemType =
    patch.workItemType ??
    (typeof existing.workItemType === "string"
      ? existing.workItemType
      : undefined);
  const dueDate = formatOptionalIso(
    patch.dueDate !== undefined ? patch.dueDate : existing.dueDate,
  );
  const goal =
    patch.goal ??
    (typeof existing.goal === "string" ? existing.goal : undefined);
  const acceptanceCriteria =
    patch.acceptanceCriteria ??
    (typeof existing.acceptanceCriteria === "string"
      ? existing.acceptanceCriteria
      : undefined);
  const taskCategory =
    patch.taskCategory ??
    (typeof existing.taskCategory === "string"
      ? existing.taskCategory
      : "live_implementation");
  const strategyHorizons =
    patch.strategyHorizons ??
    (Array.isArray(existing.strategyHorizons) ? existing.strategyHorizons : []);
  const blockedReason =
    patch.blockedReason ??
    (typeof existing.blockedReason === "string"
      ? existing.blockedReason
      : undefined);
  const unblockPolicy =
    patch.unblockPolicy ??
    (typeof existing.unblockPolicy === "string"
      ? existing.unblockPolicy
      : undefined);
  const completionSummary =
    patch.completionSummary ??
    (typeof existing.completionSummary === "string"
      ? existing.completionSummary
      : undefined);

  const body: Record<string, unknown> = {
    title,
    description,
    status,
    priority: priorityRaw,
    projectId,
    position,
    goal,
    acceptanceCriteria,
    blockedReason,
    unblockPolicy,
    completionSummary,
    taskCategory,
    strategyHorizons,
  };

  if (patch.unblockNote !== undefined) {
    body.unblockNote = patch.unblockNote;
  }

  if (startDate !== undefined) {
    body.startDate = startDate;
  }
  if (dueDate !== undefined) {
    body.dueDate = dueDate;
  }
  if (userId !== undefined) {
    body.userId = userId;
  }
  if (workItemType !== undefined) {
    body.workItemType = workItemType;
  }

  return body;
}

function formatOptionalIso(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    return value;
  }
  return undefined;
}
