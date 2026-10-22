import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { labelTable, projectTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { removeLabelFromGitea } from "../../plugins/gitea/utils/sync-label-to-gitea";
import { removeLabelFromGitHub } from "../../plugins/github/utils/sync-label-to-github";

/** Delete label and its protected task copies before publishing side effects. */
async function deleteLabel(id: string, userId: string, workspaceId?: string) {
  const { deletedLabel, affectedLabels, taskLevel } = await db.transaction(
    async (tx) => {
      const label = await tx.query.labelTable.findFirst({
        where: eq(labelTable.id, id),
      });
      if (!label) throw new HTTPException(404, { message: "Label not found" });
      const copiesCondition = label.taskId
        ? eq(labelTable.id, id)
        : label.workspaceId
          ? and(
              eq(labelTable.workspaceId, label.workspaceId),
              eq(labelTable.name, label.name),
              isNotNull(labelTable.taskId),
            )
          : undefined;
      const affectedLabels = copiesCondition
        ? await tx
            .select({
              label: labelTable,
              taskId: taskTable.id,
              projectId: projectTable.id,
              workspaceId: projectTable.workspaceId,
            })
            .from(labelTable)
            .innerJoin(taskTable, eq(labelTable.taskId, taskTable.id))
            .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
            .where(copiesCondition)
        : [];
      if (label.taskId && affectedLabels.length !== 1)
        throw new HTTPException(404, { message: "Task not found" });
      const taskIds = [...new Set(affectedLabels.map((copy) => copy.taskId))];
      if (taskIds.length) {
        const locked = await tx
          .select({ id: taskTable.id, projectId: taskTable.projectId })
          .from(taskTable)
          .where(inArray(taskTable.id, taskIds))
          .orderBy(asc(taskTable.id))
          .for("update");
        const projectsByTask = new Map(
          affectedLabels.map((copy) => [copy.taskId, copy.projectId]),
        );
        if (
          locked.length !== taskIds.length ||
          locked.some((task) => projectsByTask.get(task.id) !== task.projectId)
        )
          throw new HTTPException(409, {
            message: "Label tasks moved or disappeared; reload before deleting",
          });
        const projectIds = [...new Set(locked.map((task) => task.projectId))];
        const projects = await tx
          .select({ workspaceId: projectTable.workspaceId })
          .from(projectTable)
          .where(inArray(projectTable.id, projectIds));
        if (
          workspaceId &&
          (projects.length !== projectIds.length ||
            projects.some((project) => project.workspaceId !== workspaceId))
        )
          throw new HTTPException(409, {
            message: "Label task workspace changed; reload before deleting",
          });
      }
      const [current] = await tx
        .select()
        .from(labelTable)
        .where(eq(labelTable.id, id))
        .for("update");
      if (!current)
        throw new HTTPException(404, { message: "Label not found" });
      if (
        current.name !== label.name ||
        current.color !== label.color ||
        current.taskId !== label.taskId ||
        current.workspaceId !== label.workspaceId
      )
        throw new HTTPException(409, {
          message: "Label changed; reload before deleting",
        });
      if (
        workspaceId &&
        current.workspaceId &&
        current.workspaceId !== workspaceId
      )
        throw new HTTPException(409, {
          message: "Label workspace changed; reload before deleting",
        });
      if (copiesCondition) {
        const latest = await tx
          .select()
          .from(labelTable)
          .where(copiesCondition);
        const snapshot = new Map(
          affectedLabels.map((copy) => [copy.label.id, copy.label]),
        );
        if (
          latest.length !== snapshot.size ||
          latest.some((copy) => {
            const before = snapshot.get(copy.id);
            return (
              !before ||
              before.taskId !== copy.taskId ||
              before.name !== copy.name ||
              before.color !== copy.color
            );
          })
        )
          throw new HTTPException(409, {
            message: "Label assignments changed; reload before deleting",
          });
      }
      const ids = [
        ...new Set([id, ...affectedLabels.map((copy) => copy.label.id)]),
      ];
      const removed = await tx
        .delete(labelTable)
        .where(inArray(labelTable.id, ids))
        .returning();
      const deletedLabel = removed.find((label) => label.id === id);
      if (!deletedLabel || removed.length !== ids.length)
        throw new HTTPException(409, {
          message: "Label deletion did not complete; no changes committed",
        });
      if (taskIds.length)
        await tx
          .update(taskTable)
          .set({ updatedAt: new Date() })
          .where(inArray(taskTable.id, taskIds));
      return { deletedLabel, affectedLabels, taskLevel: Boolean(label.taskId) };
    },
  );

  for (const { label, taskId, projectId, workspaceId } of affectedLabels) {
    removeLabelFromGitHub(taskId, label.name).catch((error) => {
      console.error("Failed to remove label from GitHub:", error);
    });
    if (!taskLevel)
      removeLabelFromGitea(taskId, label.name).catch((error) => {
        console.error("Failed to remove label from Gitea:", error);
      });
    await publishEvent("task.label_deleted", {
      label,
      task: taskLevel
        ? { id: taskId, projectId, workspaceId }
        : { id: taskId, projectId },
      projectId,
      taskId,
      userId,
      type: "label_deleted",
    });
  }
  return deletedLabel;
}

export default deleteLabel;
