import type { InferSelectModel } from "drizzle-orm";
import { and, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../../database";
import {
  columnTable,
  externalLinkTable,
  integrationTable,
  taskTable,
} from "../../../database/schema";
import { VIRTUAL_STATUSES } from "../../../task/validate-task-fields";
import type { ValidPriority } from "../utils/extract-priority";

export type TaskRow = InferSelectModel<typeof taskTable>;

export type UpdateTaskStatusResult =
  | { applied: false }
  | { applied: true; before: TaskRow; after: TaskRow };

const NON_COLUMN_STATUSES: ReadonlySet<string> = new Set(VIRTUAL_STATUSES);

/** Compare event field history under task lock instead of overwriting local edits. */
export async function updateProviderTaskText(
  taskId: string,
  projectId: string,
  fields: {
    title?: { before: string; after: string };
    description?: { before: string; after: string };
  },
  sync?: {
    linkId: string;
    integrationId: string;
    externalId: string;
    source: "github" | "gitea";
  },
) {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(taskTable)
      .where(eq(taskTable.id, taskId))
      .for("update");
    if (!task) return { applied: false };
    const conflict = (field: string) => {
      throw new HTTPException(409, {
        res: Response.json(
          {
            error: "TASK_CONFLICT",
            field,
            currentVersion: task.version,
            message:
              "Task field diverged from provider event; reconcile before retrying",
          },
          { status: 409 },
        ),
      });
    };
    if (task.projectId !== projectId) conflict("projectId");
    const [link] = sync
      ? await tx
          .select()
          .from(externalLinkTable)
          .where(
            and(
              eq(externalLinkTable.id, sync.linkId),
              eq(externalLinkTable.taskId, taskId),
              eq(externalLinkTable.integrationId, sync.integrationId),
              eq(externalLinkTable.externalId, sync.externalId),
              eq(externalLinkTable.resourceType, "issue"),
            ),
          )
          .for("update")
      : [];
    if (sync && !link) conflict("externalLink");
    const record = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    let metadata: Record<string, unknown> = {};
    if (link?.metadata) {
      try {
        const parsed: unknown = JSON.parse(link.metadata);
        if (!record(parsed)) conflict("externalLink.metadata");
        metadata = parsed as Record<string, unknown>;
      } catch {
        conflict("externalLink.metadata");
      }
    }
    if (metadata.lastSync !== undefined && !record(metadata.lastSync))
      conflict("externalLink.lastSync");
    const lastSync = record(metadata.lastSync) ? { ...metadata.lastSync } : {};
    let metadataChanged = false;
    let linkTitle: string | undefined;
    const values: { title?: string; description?: string } = {};
    for (const key of ["title", "description"] as const) {
      const change = fields[key];
      if (!change) continue;
      const previous = lastSync[key];
      if (
        sync &&
        record(previous) &&
        previous.source === "kaneo" &&
        previous.value === change.after
      )
        continue;
      const current = task[key] ?? "";
      if (current !== change.after) {
        if (current !== change.before) conflict(key);
        values[key] = change.after;
      }
      if (
        sync &&
        (!record(previous) ||
          previous.source !== sync.source ||
          previous.value !== change.after)
      ) {
        lastSync[key] = {
          timestamp: new Date().toISOString(),
          source: sync.source,
          value: change.after,
        };
        metadataChanged = true;
      }
      if (sync && key === "title" && link?.title !== change.after)
        linkTitle = change.after;
    }
    const applied = Object.keys(values).length > 0;
    if (applied) {
      const updated = await tx
        .update(taskTable)
        .set(values)
        .where(eq(taskTable.id, taskId))
        .returning({ id: taskTable.id });
      if (updated.length !== 1) conflict("task");
    }
    if (link && (metadataChanged || linkTitle !== undefined)) {
      const updated = await tx
        .update(externalLinkTable)
        .set({
          ...(metadataChanged
            ? { metadata: JSON.stringify({ ...metadata, lastSync }) }
            : {}),
          ...(linkTitle !== undefined ? { title: linkTitle } : {}),
        })
        .where(eq(externalLinkTable.id, link.id))
        .returning({ id: externalLinkTable.id });
      if (updated.length !== 1) conflict("externalLink");
    }
    return { applied };
  });
}

/** Apply provider priority only when it changes; duplicate deliveries keep revision. */
export async function updateTaskPriority(
  taskId: string,
  priority: ValidPriority,
) {
  const updated = await db
    .update(taskTable)
    .set({ priority })
    .where(
      and(
        eq(taskTable.id, taskId),
        sql`${taskTable.priority} IS DISTINCT FROM ${priority}`,
      ),
    )
    .returning({ id: taskTable.id });
  return updated.length > 0;
}

export async function findTaskByNumber(projectId: string, taskNumber: number) {
  return db.query.taskTable.findFirst({
    where: and(
      eq(taskTable.projectId, projectId),
      eq(taskTable.number, taskNumber),
    ),
  });
}

export async function findTaskById(taskId: string) {
  return db.query.taskTable.findFirst({
    where: eq(taskTable.id, taskId),
  });
}

export async function updateTaskStatus(
  taskId: string,
  newStatus: string,
  options: { onlyIfNotFinal?: boolean; expectedProjectId?: string } = {},
): Promise<UpdateTaskStatusResult> {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(taskTable)
      .where(eq(taskTable.id, taskId))
      .for("update");
    if (!task) return { applied: false };
    if (
      options.expectedProjectId &&
      task.projectId !== options.expectedProjectId
    ) {
      return { applied: false };
    }
    if (options.onlyIfNotFinal && (await isTaskInFinalState(task, tx))) {
      return { applied: false };
    }

    const column = await tx.query.columnTable.findFirst({
      where: and(
        eq(columnTable.projectId, task.projectId),
        eq(columnTable.slug, newStatus),
      ),
    });
    if (!column && !NON_COLUMN_STATUSES.has(newStatus)) {
      console.warn(
        `[GitHub] Skipping status update for task ${taskId}: column "${newStatus}" not found in project ${task.projectId}`,
      );
      return { applied: false };
    }
    const columnId = column?.id ?? null;
    if (task.status === newStatus && task.columnId === columnId) {
      return { applied: false };
    }

    const [after] = await tx
      .update(taskTable)
      .set({ status: newStatus, columnId })
      .where(eq(taskTable.id, taskId))
      .returning();
    if (!after) return { applied: false };
    return { applied: true, before: task, after };
  });
}

export async function isTaskInFinalState(
  task: {
    projectId: string;
    status: string;
    columnId: string | null;
  },
  reader: Pick<typeof db, "query"> = db,
): Promise<boolean> {
  if (task.columnId) {
    const columnById = await reader.query.columnTable.findFirst({
      where: and(
        eq(columnTable.id, task.columnId),
        eq(columnTable.projectId, task.projectId),
      ),
    });

    if (columnById) {
      return columnById.isFinal;
    }
  }

  const columnByStatus = await reader.query.columnTable.findFirst({
    where: and(
      eq(columnTable.projectId, task.projectId),
      eq(columnTable.slug, task.status),
    ),
  });

  if (columnByStatus) {
    return columnByStatus.isFinal;
  }

  return task.status === "done";
}

export async function getIntegrationWithProject(integrationId: string) {
  return db.query.integrationTable.findFirst({
    where: eq(integrationTable.id, integrationId),
    with: {
      project: true,
    },
  });
}

export async function findIntegrationByRepo(owner: string, repo: string) {
  const integrations = await findAllIntegrationsByRepo(owner, repo);
  return integrations[0] || null;
}

export async function findAllIntegrationsByRepo(owner: string, repo: string) {
  const integrations = await db.query.integrationTable.findMany({
    where: and(
      eq(integrationTable.type, "github"),
      eq(integrationTable.isActive, true),
    ),
    with: {
      project: true,
    },
  });

  return integrations.filter((integration) => {
    try {
      const config = JSON.parse(integration.config);
      return config.repositoryOwner === owner && config.repositoryName === repo;
    } catch {
      return false;
    }
  });
}
