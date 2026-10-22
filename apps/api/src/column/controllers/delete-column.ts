import { and, eq, or } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { columnTable, projectTable, taskTable } from "../../database/schema";

async function deleteColumn(id: string) {
  const existing = await db.query.columnTable.findFirst({
    where: eq(columnTable.id, id),
  });

  if (!existing) {
    throw new HTTPException(404, { message: "Column not found" });
  }

  return db.transaction(async (tx) => {
    // Group operations and workflow deletion take project lock before column locks.
    const [project] = await tx
      .select({ id: projectTable.id })
      .from(projectTable)
      .where(eq(projectTable.id, existing.projectId))
      .for("update");
    if (!project)
      throw new HTTPException(404, { message: "Project not found" });
    const [column] = await tx
      .select()
      .from(columnTable)
      .where(eq(columnTable.id, id))
      .for("update");
    if (!column) throw new HTTPException(404, { message: "Column not found" });
    if (column.projectId !== project.id)
      throw new HTTPException(409, { message: "Column project changed" });
    const [task] = await tx
      .select({ id: taskTable.id })
      .from(taskTable)
      .where(
        or(
          eq(taskTable.columnId, id),
          and(
            eq(taskTable.projectId, project.id),
            eq(taskTable.status, column.slug),
          ),
        ),
      )
      .limit(1);
    if (task)
      throw new HTTPException(409, {
        message:
          "Cannot delete column that contains tasks. Move or delete tasks first.",
      });
    const [deleted] = await tx
      .delete(columnTable)
      .where(eq(columnTable.id, id))
      .returning();
    if (!deleted) throw new HTTPException(404, { message: "Column not found" });
    return deleted;
  });
}

export default deleteColumn;
