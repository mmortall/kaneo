export const TASK_HORIZONS = [
  "short",
  "position",
  "long_term",
  "ultra_long_term",
] as const;

export type TaskHorizon = (typeof TASK_HORIZONS)[number];

export function normalizeTaskHorizons(
  horizons: readonly TaskHorizon[] | undefined,
): TaskHorizon[] {
  return horizons ? [...new Set(horizons)] : [];
}
