import { and, eq, isNull, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { labelTable, projectTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { syncLabelToGitea } from "../../plugins/gitea/utils/sync-label-to-gitea";
import { syncLabelToGitHub } from "../../plugins/github/utils/sync-label-to-github";

async function createLabel(
  name: string,
  color: string,
  taskId: string | undefined,
  workspaceId: string,
  userId: string,
) {
  if (taskId) {
    const { task, label, inserted } = await db.transaction(async (tx) => {
      const [task] = await tx
        .select({
          id: taskTable.id,
          projectId: taskTable.projectId,
          workspaceId: projectTable.workspaceId,
        })
        .from(taskTable)
        .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
        .where(eq(taskTable.id, taskId))
        .for("update", { of: taskTable });

      if (!task) {
        throw new HTTPException(404, {
          message: "Task not found",
        });
      }

      if (task.workspaceId !== workspaceId) {
        throw new HTTPException(404, {
          message: "Task not found",
        });
      }

      const [inserted] = await tx
        .insert(labelTable)
        .values({ name, color, taskId, workspaceId: task.workspaceId })
        .onConflictDoNothing({
          target: [labelTable.taskId, labelTable.name],
        })
        .returning();

      const label =
        inserted ??
        (await tx.query.labelTable.findFirst({
          where: and(eq(labelTable.taskId, taskId), eq(labelTable.name, name)),
        }));

      if (!label) {
        throw new Error("Failed to create or resolve label");
      }

      if (inserted)
        await tx
          .update(taskTable)
          .set({ updatedAt: new Date() })
          .where(eq(taskTable.id, taskId));
      return { task, label, inserted };
    });

    if (inserted) {
      syncLabelToGitHub(taskId, name, color).catch((error) => {
        console.error("Failed to sync label to GitHub:", error);
      });
      syncLabelToGitea(taskId, name, color).catch((error) => {
        console.error("Failed to sync label to Gitea:", error);
      });

      await publishEvent("task.label_created", {
        projectId: task.projectId,
        taskId: task.id,
        userId: userId,
        type: "label_created",
      });
    }
    return label;
  }

  const [inserted] = await db
    .insert(labelTable)
    .values({ name, color, taskId: null, workspaceId })
    .onConflictDoNothing({
      target: [labelTable.workspaceId, labelTable.name],
      where: sql`${labelTable.taskId} is null`,
    })
    .returning();

  const label =
    inserted ??
    (await db.query.labelTable.findFirst({
      where: and(
        eq(labelTable.workspaceId, workspaceId),
        eq(labelTable.name, name),
        isNull(labelTable.taskId),
      ),
    }));

  if (!label) {
    throw new Error("Failed to create or resolve label");
  }

  return label;
}

export default createLabel;
