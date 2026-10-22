import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { labelTable, projectTable, taskTable } from "../../database/schema";

/** Apply one provider label delta and advance task revision only on actual change. */
export default async function applyProviderLabelEvent(
  taskId: string,
  workspaceId: string,
  label: { name: string; color: string },
  action: "add" | "remove",
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
        message: "Task workspace changed; reload before applying label event",
      });
    const changed =
      action === "add"
        ? (
            await tx
              .insert(labelTable)
              .values({ ...label, taskId, workspaceId })
              .onConflictDoNothing({
                target: [labelTable.taskId, labelTable.name],
              })
              .returning({ id: labelTable.id })
          ).length
        : (
            await tx
              .delete(labelTable)
              .where(
                and(
                  eq(labelTable.taskId, taskId),
                  eq(labelTable.name, label.name),
                ),
              )
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
