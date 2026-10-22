import db from "../../database";
import { activityTable } from "../../database/schema";

async function createActivity(
  taskId: string,
  type: string,
  userId: string,
  content: string | null,
  eventData?: Record<string, unknown> | null,
  operationKey?: string,
) {
  const insertion = db.insert(activityTable).values({
    taskId,
    type,
    userId,
    content,
    eventData: eventData ?? null,
    ...(operationKey ? { operationKey } : {}),
  });
  const [activity] = await (operationKey
    ? insertion.onConflictDoNothing({ target: activityTable.operationKey })
    : insertion
  ).returning();
  return activity;
}

export default createActivity;
