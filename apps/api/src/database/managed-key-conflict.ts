/** Recognize managed identity conflicts without exposing database queries. */
export function managedKeyConflict(error: unknown): boolean {
  let current = error;
  for (
    let depth = 0;
    depth < 5 && current && typeof current === "object";
    depth++
  ) {
    const value = current as {
      code?: string;
      constraint?: string;
      cause?: unknown;
    };
    if (
      (value.code === "23505" &&
        value.constraint === "task_project_managed_key_unique") ||
      (value.code === "23514" &&
        value.constraint === "task_managed_marker_matches_key")
    )
      return true;
    current = value.cause;
  }
  return false;
}
