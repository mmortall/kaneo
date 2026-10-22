import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type db from "../../database";
import { projectTable, taskTable } from "../../database/schema";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Serialize type changes with hierarchy writers before taking task locks. */
export default async function lockTaskTypeProject(
  tx: Transaction,
  taskId: string,
  workspaceId?: string,
) {
  const [task] = await tx
    .select({ projectId: taskTable.projectId })
    .from(taskTable)
    .where(eq(taskTable.id, taskId));
  if (!task) throw new HTTPException(404, { message: "Task not found" });
  const [project] = await tx
    .select({ id: projectTable.id, workspaceId: projectTable.workspaceId })
    .from(projectTable)
    .where(eq(projectTable.id, task.projectId))
    .for("update");
  if (!project || (workspaceId && project.workspaceId !== workspaceId))
    throw new HTTPException(409, {
      message: "Task workspace changed; reload before retrying",
    });
  return project.id;
}
