import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { labelTable, projectTable, taskTable } from "../../database/schema";

/** Apply provider label intent under task lock, advancing revision once on change. */
export default async function importTaskLabels(
  taskId: string,
  workspaceId: string,
  labels: { name: string; color: string }[],
  mode: "append" | "replace",
) {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select({ projectId: taskTable.projectId })
      .from(taskTable)
      .where(eq(taskTable.id, taskId))
      .for("update");
    if (!task) throw new HTTPException(404, { message: "Task not found" });
    const [project] = await tx
      .select({ workspaceId: projectTable.workspaceId })
      .from(projectTable)
      .where(eq(projectTable.id, task.projectId));
    if (project?.workspaceId !== workspaceId)
      throw new HTTPException(409, {
        message: "Task workspace changed; reload before importing labels",
      });
    const desired = new Map<string, string>();
    for (const label of labels)
      if (!desired.has(label.name)) desired.set(label.name, label.color);
    const existing = await tx
      .select()
      .from(labelTable)
      .where(eq(labelTable.taskId, taskId));
    const existingNames = new Set(existing.map((label) => label.name));
    const missing = [...desired.keys()].filter(
      (name) => !existingNames.has(name),
    );
    const definitions = missing.length
      ? await tx
          .select()
          .from(labelTable)
          .where(
            and(
              eq(labelTable.workspaceId, workspaceId),
              isNull(labelTable.taskId),
              inArray(labelTable.name, missing),
            ),
          )
          .orderBy(asc(labelTable.id))
          .for("update")
      : [];
    const colors = new Map(
      definitions.map((label) => [label.name, label.color]),
    );
    let changed = 0;
    const removedIds =
      mode === "replace"
        ? existing
            .filter((label) => !desired.has(label.name))
            .map((label) => label.id)
        : [];
    if (removedIds.length)
      changed += (
        await tx
          .delete(labelTable)
          .where(inArray(labelTable.id, removedIds))
          .returning({ id: labelTable.id })
      ).length;
    if (missing.length)
      changed += (
        await tx
          .insert(labelTable)
          .values(
            missing.map((name) => ({
              name,
              color: colors.get(name) || desired.get(name)!,
              taskId,
              workspaceId,
            })),
          )
          .onConflictDoNothing({ target: [labelTable.taskId, labelTable.name] })
          .returning({ id: labelTable.id })
      ).length;
    if (changed)
      await tx
        .update(taskTable)
        .set({ updatedAt: new Date() })
        .where(eq(taskTable.id, taskId));
    return { changed };
  });
}
