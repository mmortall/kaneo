import { and, eq } from "drizzle-orm";
import db from "../../database";
import { columnTable, type taskTable } from "../../database/schema";
import {
  assertTaskMutationAllowed,
  isAiTaskCaller,
} from "../task-workflow-policy";

/** Apply final-column policy to dedicated field mutations without changing human edits. */
export default async function assertFieldMutationPolicy(
  existing: typeof taskTable.$inferSelect,
  caller?: string,
) {
  if (!isAiTaskCaller(caller)) return;
  const [finalColumn] = await db
    .select({ id: columnTable.id })
    .from(columnTable)
    .where(
      and(
        eq(columnTable.projectId, existing.projectId),
        eq(columnTable.slug, existing.status),
        eq(columnTable.isFinal, true),
      ),
    )
    .limit(1);
  assertTaskMutationAllowed({
    caller,
    existing,
    isFinalStatus: existing.status === "done" || Boolean(finalColumn),
  });
}
