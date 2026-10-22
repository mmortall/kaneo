type TaskLabel = {
  id: string;
  name: string;
  color: string;
};

type TaskExternalLink = {
  id: string;
  taskId: string;
  integrationId: string;
  resourceType: string;
  externalId: string;
  url: string;
  title: string | null;
  metadata: Record<string, unknown> | null;
};

export const TASK_CATEGORIES = [
  "live_implementation",
  "research",
  "agent_blocker",
] as const;

export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export const TASK_HORIZONS = [
  "short",
  "position",
  "long_term",
  "ultra_long_term",
] as const;

export type TaskHorizon = (typeof TASK_HORIZONS)[number];

type Task = {
  isSummary?: true;
  id: string;
  version?: number;
  title: string;
  number: number | null;
  description: string | null;
  goal?: string | null;
  acceptanceCriteria?: string | null;
  blockedReason?: string | null;
  unblockPolicy?: string | null;
  completionSummary?: string | null;
  status: string;
  priority: string | null;
  workItemType?: string;
  taskCategory?: TaskCategory;
  strategyHorizons?: TaskHorizon[];
  startDate: string | null;
  dueDate: string | null;
  position: number | null;
  createdAt: string;
  updatedAt?: string;
  userId: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  assigneeImage?: string | null;
  projectId: string;
  columnId?: string | null;
  labels?: TaskLabel[];
  externalLinks?: TaskExternalLink[];
};

export default Task;
