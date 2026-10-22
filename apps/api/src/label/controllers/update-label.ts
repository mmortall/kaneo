import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { labelTable, projectTable, taskTable } from "../../database/schema";

async function updateLabel(
  id: string,
  name: string,
  color: string,
  workspaceId?: string,
) {
  return db.transaction(async (tx) => {
    const label = await tx.query.labelTable.findFirst({
      where: (label, { eq }) => eq(label.id, id),
    });

    if (!label) {
      throw new HTTPException(404, {
        message: "Label not found",
      });
    }

    const copiesCondition = label.taskId
      ? eq(labelTable.id, id)
      : label.workspaceId
        ? and(
            eq(labelTable.workspaceId, label.workspaceId),
            eq(labelTable.name, label.name),
            isNotNull(labelTable.taskId),
          )
        : undefined;
    const copies = copiesCondition
      ? await tx
          .select({
            id: labelTable.id,
            taskId: labelTable.taskId,
            color: labelTable.color,
          })
          .from(labelTable)
          .where(copiesCondition)
      : [];
    const taskIds = [
      ...new Set(copies.flatMap((copy) => (copy.taskId ? [copy.taskId] : []))),
    ];
    if (taskIds.length) {
      const locked = await tx
        .select({ id: taskTable.id, projectId: taskTable.projectId })
        .from(taskTable)
        .where(inArray(taskTable.id, taskIds))
        .orderBy(asc(taskTable.id))
        .for("update");
      if (locked.length !== taskIds.length)
        throw new HTTPException(409, {
          message: "Label tasks changed; reload before renaming",
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
          message: "Label task workspace changed; reload before renaming",
        });
    }
    const [current] = await tx
      .select()
      .from(labelTable)
      .where(eq(labelTable.id, id))
      .for("update");
    if (!current) throw new HTTPException(404, { message: "Label not found" });
    if (
      current.name !== label.name ||
      current.color !== label.color ||
      current.taskId !== label.taskId ||
      current.workspaceId !== label.workspaceId
    )
      throw new HTTPException(409, {
        message: "Label changed; reload before renaming",
      });
    if (
      workspaceId &&
      current.workspaceId &&
      current.workspaceId !== workspaceId
    )
      throw new HTTPException(409, {
        message: "Label workspace changed; reload before renaming",
      });
    if (copiesCondition) {
      const latest = await tx
        .select({
          id: labelTable.id,
          taskId: labelTable.taskId,
          color: labelTable.color,
        })
        .from(labelTable)
        .where(copiesCondition);
      const snapshot = new Map(copies.map((copy) => [copy.id, copy]));
      if (
        latest.length !== copies.length ||
        latest.some(
          (copy) =>
            !snapshot.has(copy.id) ||
            snapshot.get(copy.id)!.taskId !== copy.taskId ||
            snapshot.get(copy.id)!.color !== copy.color,
        )
      )
        throw new HTTPException(409, {
          message: "Label assignments changed; reload before renaming",
        });
    }
    const changedCopies = copies.filter(
      (copy) => label.name !== name || copy.color !== color,
    );
    if (
      current.name === name &&
      current.color === color &&
      changedCopies.length === 0
    )
      return current;
    let updatedLabel = current;
    if (current.name !== name || current.color !== color) {
      const [updated] = await tx
        .update(labelTable)
        .set({ name, color })
        .where(eq(labelTable.id, id))
        .returning();
      if (!updated)
        throw new HTTPException(409, {
          message: "Label disappeared during rename",
        });
      updatedLabel = updated;
    }

    // If this is a workspace-level label, cascade the changes to all
    // task-level copies so existing label assignments reflect the new color/name
    if (!label.taskId && changedCopies.length) {
      await tx
        .update(labelTable)
        .set({ name, color })
        .where(
          inArray(
            labelTable.id,
            changedCopies.map((copy) => copy.id),
          ),
        );
    }

    const changedTaskIds = [
      ...new Set(
        changedCopies.flatMap((copy) => (copy.taskId ? [copy.taskId] : [])),
      ),
    ];
    if (changedTaskIds.length)
      await tx
        .update(taskTable)
        .set({ updatedAt: new Date() })
        .where(inArray(taskTable.id, changedTaskIds));

    return updatedLabel;
  });
}

export default updateLabel;
