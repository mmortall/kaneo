import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { taskTable, userTable } from "../../database/schema";
import { publishEvent } from "../../events";
import assertFieldMutationPolicy from "./assert-field-mutation-policy";

async function updateTaskAssignee({
  id,
  userId,
  currentUserId,
  caller,
}: {
  id: string;
  userId: string | null;
  currentUserId: string;
  caller?: string;
}) {
  const existingTask = await db.query.taskTable.findFirst({
    where: eq(taskTable.id, id),
  });

  if (!existingTask) {
    throw new HTTPException(404, {
      message: "Task not found",
    });
  }

  await assertFieldMutationPolicy(existingTask, caller);

  const nextAssigneeId = userId || null;
  if (existingTask.userId === nextAssigneeId) {
    return existingTask;
  }

  const [updatedTask] = await db
    .update(taskTable)
    .set({ userId: nextAssigneeId || null })
    .where(
      and(eq(taskTable.id, id), eq(taskTable.version, existingTask.version)),
    )
    .returning();

  if (!updatedTask) {
    throw new HTTPException(409, {
      message: "Task changed during validation; reload before retrying",
    });
  }

  const newAssigneeName = userId
    ? (
        await db
          .select({ name: userTable.name })
          .from(userTable)
          .where(eq(userTable.id, userId))
          .limit(1)
      )[0]?.name
    : undefined;

  if (!userId) {
    await publishEvent("task.unassigned", {
      taskId: updatedTask.id,
      projectId: updatedTask.projectId,
      userId: currentUserId,
      title: updatedTask.title,
      type: "unassigned",
    });

    return updatedTask;
  }

  await publishEvent("task.assignee_changed", {
    taskId: updatedTask.id,
    projectId: updatedTask.projectId,
    userId: currentUserId,
    oldAssignee: existingTask.userId,
    newAssignee: newAssigneeName,
    newAssigneeId: userId,
    title: updatedTask.title,
    type: "assignee_changed",
  });

  return updatedTask;
}

export default updateTaskAssignee;
