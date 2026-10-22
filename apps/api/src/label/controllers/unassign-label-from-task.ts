import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { labelTable, projectTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import { removeLabelFromGitHub } from "../../plugins/github/utils/sync-label-to-github";

async function unassignLabelFromTask(
  id: string,
  userId: string,
  workspaceId?: string,
) {
  const label = await db.query.labelTable.findFirst({
    where: (label, { eq }) => eq(label.id, id),
  });

  if (!label) {
    throw new HTTPException(404, {
      message: "Label not found",
    });
  }

  if (!label.taskId) {
    throw new HTTPException(400, {
      message: "Label is not assigned to a task",
    });
  }

  const [task] = await db
    .select({
      id: taskTable.id,
      projectId: taskTable.projectId,
      workspaceId: projectTable.workspaceId,
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(eq(taskTable.id, label.taskId))
    .limit(1);

  if (!task) {
    throw new HTTPException(404, {
      message: "Task not found",
    });
  }

  const deletedLabel = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ projectId: taskTable.projectId })
      .from(taskTable)
      .where(eq(taskTable.id, task.id))
      .for("update");
    if (!locked || locked.projectId !== task.projectId)
      throw new HTTPException(409, {
        message: "Task moved or disappeared; reload before detaching label",
      });
    const [project] = await tx
      .select({ workspaceId: projectTable.workspaceId })
      .from(projectTable)
      .where(eq(projectTable.id, locked.projectId));
    if (!project || project.workspaceId !== (workspaceId ?? task.workspaceId))
      throw new HTTPException(409, {
        message: "Task workspace changed; reload before detaching label",
      });
    const [current] = await tx
      .select()
      .from(labelTable)
      .where(eq(labelTable.id, id))
      .for("update");
    if (!current) throw new HTTPException(404, { message: "Label not found" });
    if (current.taskId !== task.id)
      throw new HTTPException(409, {
        message: "Label assignment changed; reload before detaching label",
      });
    const [deleted] = await tx
      .delete(labelTable)
      .where(eq(labelTable.id, id))
      .returning();
    if (!deleted)
      throw new HTTPException(500, {
        message: "Failed to detach label from task",
      });
    await tx
      .update(taskTable)
      .set({ updatedAt: new Date() })
      .where(eq(taskTable.id, task.id));
    return deleted;
  });

  if (!deletedLabel) {
    throw new HTTPException(500, {
      message: "Failed to detach label from task",
    });
  }

  if (deletedLabel.taskId) {
    removeLabelFromGitHub(deletedLabel.taskId, deletedLabel.name).catch(
      (error) => {
        console.error("Failed to remove label from GitHub:", error);
      },
    );
  }

  await publishEvent("task.label_unassigned", {
    label: deletedLabel,
    task,
    projectId: task.projectId,
    taskId: deletedLabel.taskId,
    userId,
    type: "label_unassigned",
  });

  return deletedLabel;
}

export default unassignLabelFromTask;
