export const VIRTUAL_TASK_STATUSES = [
  { value: "planned", name: "Planned", isFinal: false },
  { value: "blocked", name: "Blocked", isFinal: false },
  { value: "archived", name: "Archived", isFinal: true },
] as const;
