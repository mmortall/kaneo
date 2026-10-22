import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  columnTable,
  projectTable,
  taskRelationTable,
} from "../../database/schema";
import { assertTaskWorkflowPolicy } from "../task-workflow-policy";
import {
  type ManagedSpec,
  resolveManagedCandidate,
} from "./ensure-managed-tasks";

/** Read a consistent plan using same candidates as ensure, without writes/locks. */
export default async function previewManagedTasks(
  projectId: string,
  workspaceId: string,
  items: ManagedSpec[],
) {
  return db.transaction(
    async (tx) => {
      const project = await tx.query.projectTable.findFirst({
        where: and(
          eq(projectTable.id, projectId),
          eq(projectTable.workspaceId, workspaceId),
        ),
      });
      if (!project)
        throw new HTTPException(404, { message: "Project not found" });
      const columns = await tx
        .select()
        .from(columnTable)
        .where(eq(columnTable.projectId, projectId));
      const tasks: Array<Record<string, unknown>> = [];
      const actions: string[] = [];
      for (const [index, item] of items.entries()) {
        const { task, adopt } = await resolveManagedCandidate(
          tx,
          projectId,
          item,
        );
        if (task && task.workItemType !== item.workItemType)
          throw new HTTPException(409, {
            message: "Managed task type mismatch",
          });
        if (!task) {
          const status = index === 2 ? "in-progress" : "to-do";
          if (!columns.some((c) => c.slug === status))
            throw new HTTPException(409, {
              message: `Project lacks ${status} column`,
            });
          assertTaskWorkflowPolicy({
            isAiCaller: true,
            nextStatus: status,
            fields: item,
          });
        }
        if (index > 0 && task) {
          const parents = await tx
            .select()
            .from(taskRelationTable)
            .where(
              and(
                eq(taskRelationTable.targetTaskId, task.id),
                eq(taskRelationTable.relationType, "subtask"),
              ),
            )
            .limit(2);
          if (
            parents.length > 1 ||
            (parents[0] && parents[0].sourceTaskId !== tasks[index - 1]?.id)
          )
            throw new HTTPException(409, {
              message:
                "Existing hierarchy differs; explicit reconciliation required",
            });
        }
        const marker = item.description.match(
          /<!-- kaneo-managed:[\s\S]*?-->/,
        )?.[0];
        const active =
          task && !["done", "archived", "blocked"].includes(task.status);
        tasks.push(
          task
            ? {
                ...task,
                ...(adopt
                  ? {
                      managedKey: item.key,
                      description:
                        marker &&
                        !(task.description ?? "").includes(
                          "<!-- kaneo-managed:",
                        )
                          ? `${task.description ?? ""}${task.description ? "\n\n" : ""}${marker}`
                          : task.description,
                      ...(active
                        ? {
                            goal: task.goal?.trim() ? task.goal : item.goal,
                            acceptanceCriteria: task.acceptanceCriteria?.trim()
                              ? task.acceptanceCriteria
                              : item.acceptanceCriteria,
                          }
                        : {}),
                    }
                  : {}),
              }
            : {
                ...item,
                managedKey: item.key,
                projectId,
                status: index === 2 ? "in-progress" : "to-do",
              },
        );
        actions.push(task ? (adopt ? "adopt_title" : "reuse") : "create");
      }
      return { applied: false, tasks, actions };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
