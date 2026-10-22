import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { taskTable } from "../../database/schema";
import { publishEvent } from "../../events";
import assertFieldMutationPolicy from "./assert-field-mutation-policy";

async function updateTaskPriority({
  id,
  priority,
  currentUserId,
  caller,
}: {
  id: string;
  priority: string;
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

  const [updatedTask] = await db
    .update(taskTable)
    .set({ priority })
    .where(
      and(eq(taskTable.id, id), eq(taskTable.version, existingTask.version)),
    )
    .returning();

  if (!updatedTask) {
    throw new HTTPException(409, {
      message: "Task changed during validation; reload before retrying",
    });
  }

  await publishEvent("task.priority_changed", {
    taskId: updatedTask.id,
    projectId: updatedTask.projectId,
    userId: currentUserId,
    oldPriority: existingTask.priority,
    newPriority: priority,
    title: updatedTask.title,
    type: "priority_changed",
  });

  return updatedTask;
}

export default updateTaskPriority;
