import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { taskReminderSentTable, taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import assertFieldMutationPolicy from "./assert-field-mutation-policy";

async function updateTaskDueDate({
  id,
  dueDate,
  currentUserId,
  caller,
}: {
  id: string;
  dueDate: Date | null;
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

  const updatedTask = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(taskTable)
      .set({ dueDate: dueDate || null })
      .where(
        and(eq(taskTable.id, id), eq(taskTable.version, existingTask.version)),
      )
      .returning();
    if (!updated)
      throw new HTTPException(409, {
        message: "Task changed during validation; reload before retrying",
      });
    // Clear reminders only when the new date commits.
    await tx
      .delete(taskReminderSentTable)
      .where(eq(taskReminderSentTable.taskId, id));
    return updated;
  });

  await publishEvent("task.due_date_changed", {
    taskId: updatedTask.id,
    projectId: updatedTask.projectId,
    userId: currentUserId,
    oldDueDate: existingTask.dueDate,
    newDueDate: dueDate,
    title: updatedTask.title,
    type: "due_date_changed",
  });

  return updatedTask;
}

export default updateTaskDueDate;
