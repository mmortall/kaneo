export const TASK_CATEGORIES = [
  "live_implementation",
  "research",
  "agent_blocker",
] as const;

export type TaskCategory = (typeof TASK_CATEGORIES)[number];
