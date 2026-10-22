import { eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../../database";
import { labelTable, projectTable, taskTable } from "../../../database/schema";
import { publishEvent } from "../../../events";
import applyProviderLabelEvent from "../../../label/controllers/apply-provider-label-event";
import { findExternalLink } from "../../github/services/link-manager";
import {
  updateTaskPriority,
  updateTaskStatus,
} from "../../github/services/task-service";
import {
  extractIssuePriority,
  extractIssueStatus,
} from "../../github/utils/extract-priority";
import {
  findAllIntegrationsByGiteaRepo,
  repoOwnerLogin,
} from "../services/integration-lookup";
import { isSystemLabelName } from "../utils/system-labels";
import { baseUrlFromRepositoryHtmlUrl } from "../utils/webhook-repo";

type IssueLabeledPayload = {
  action: string;
  issue: {
    number: number;
    labels?: Array<string | { name?: string; color?: string }>;
  };
  label?: {
    name: string;
    color: string;
  };
  repository: {
    owner: { login?: string; username?: string };
    name: string;
    html_url: string;
  };
};

/** Non-system labels from a Gitea issue (used when action is label_updated). */
function giteaLabelsForSync(
  labels: IssueLabeledPayload["issue"]["labels"],
): Array<{ name: string; color?: string }> {
  if (!labels) return [];
  const out: Array<{ name: string; color?: string }> = [];
  for (const raw of labels) {
    const name = typeof raw === "string" ? raw : raw.name;
    if (!name || isSystemLabelName(name)) continue;
    const color =
      typeof raw === "object" && raw && "color" in raw ? raw.color : undefined;
    out.push({ name, color });
  }
  return out;
}

function normalizedGiteaLabelColor(g: { color?: string }): string {
  return g.color ? `#${g.color.replace(/^#/, "")}` : "#6B7280";
}

export async function syncGiteaLabelsToTask(
  taskId: string,
  workspaceId: string,
  giteaLabels: Array<{ name: string; color?: string }>,
) {
  return db.transaction(async (tx) => {
    const [task] = await tx
      .select({ projectId: taskTable.projectId })
      .from(taskTable)
      .where(eq(taskTable.id, taskId))
      .for("update");
    if (!task) throw new HTTPException(404, { message: "Task not found" });
    const [project] = await tx
      .select({ workspaceId: projectTable.workspaceId })
      .from(projectTable)
      .where(eq(projectTable.id, task.projectId));
    if (project?.workspaceId !== workspaceId)
      throw new HTTPException(409, {
        message: "Task workspace changed; reload before syncing labels",
      });
    let changed = 0;
    const desiredNames = new Set(giteaLabels.map((l) => l.name));
    const existingRows = await tx.query.labelTable.findMany({
      where: eq(labelTable.taskId, taskId),
    });

    const labelsToInsert = giteaLabels
      .filter((g) => !existingRows.some((row) => row.name === g.name))
      .map((g) => ({
        name: g.name,
        color: normalizedGiteaLabelColor(g),
        taskId,
        workspaceId,
      }));

    const colorToIds = new Map<string, string[]>();
    for (const g of giteaLabels) {
      if (isSystemLabelName(g.name)) continue;
      const row = existingRows.find((r) => r.name === g.name);
      if (!row) continue;
      const want = normalizedGiteaLabelColor(g);
      const have = row.color ? `#${row.color.replace(/^#/, "")}` : "#6B7280";
      if (have === want) continue;
      const list = colorToIds.get(want) ?? [];
      list.push(row.id);
      colorToIds.set(want, list);
    }

    for (const [color, ids] of colorToIds) {
      if (ids.length === 0) continue;
      changed += (
        await tx
          .update(labelTable)
          .set({ color })
          .where(inArray(labelTable.id, ids))
          .returning({ id: labelTable.id })
      ).length;
    }

    if (labelsToInsert.length > 0) {
      changed += (
        await tx
          .insert(labelTable)
          .values(labelsToInsert)
          .onConflictDoNothing({
            target: [labelTable.taskId, labelTable.name],
          })
          .returning({ id: labelTable.id })
      ).length;
    }

    const labelsToDelete = existingRows
      .filter(
        (row) => !desiredNames.has(row.name) && !isSystemLabelName(row.name),
      )
      .map((row) => row.id);

    if (labelsToDelete.length > 0) {
      changed += (
        await tx
          .delete(labelTable)
          .where(inArray(labelTable.id, labelsToDelete))
          .returning({ id: labelTable.id })
      ).length;
    }
    if (changed)
      await tx
        .update(taskTable)
        .set({ updatedAt: new Date() })
        .where(eq(taskTable.id, taskId));
    return { changed };
  });
}

export async function handleGiteaIssueLabeled(
  payload: IssueLabeledPayload,
  integrationId?: string,
) {
  const { issue, repository, label: addedLabel } = payload;

  const baseUrl = baseUrlFromRepositoryHtmlUrl(repository.html_url);
  if (!baseUrl) return;

  const owner = repoOwnerLogin(repository);
  const integrations = await findAllIntegrationsByGiteaRepo(
    baseUrl,
    owner,
    repository.name,
    integrationId,
  );

  for (const integration of integrations) {
    try {
      const existingLink = await findExternalLink(
        integration.id,
        "issue",
        issue.number.toString(),
      );

      if (!existingLink) {
        continue;
      }

      const priority = extractIssuePriority(issue.labels);
      const status = extractIssueStatus(issue.labels);

      if (priority) {
        await updateTaskPriority(existingLink.taskId, priority);
      }

      if (status) {
        const statusResult = await updateTaskStatus(
          existingLink.taskId,
          status,
        );
        if (
          statusResult.applied &&
          statusResult.before.status !== statusResult.after.status
        ) {
          await publishEvent("task.status_changed", {
            taskId: statusResult.after.id,
            projectId: statusResult.after.projectId,
            userId: null,
            oldStatus: statusResult.before.status,
            newStatus: statusResult.after.status,
            title: statusResult.after.title,
            assigneeId: statusResult.after.userId,
            type: "status_changed",
          });
        }
      }

      if (payload.action === "label_updated") {
        if (issue.labels === undefined) {
          continue;
        }

        const task = await db.query.taskTable.findFirst({
          where: eq(taskTable.id, existingLink.taskId),
          with: {
            project: true,
          },
        });
        if (task?.project?.workspaceId) {
          await syncGiteaLabelsToTask(
            existingLink.taskId,
            task.project.workspaceId,
            giteaLabelsForSync(issue.labels),
          );
        }
        continue;
      }

      if (!addedLabel) {
        continue;
      }

      if (isSystemLabelName(addedLabel.name)) {
        continue;
      }

      if (payload.action === "labeled" || payload.action === "unlabeled") {
        const task = await db.query.taskTable.findFirst({
          where: eq(taskTable.id, existingLink.taskId),
          with: { project: true },
        });
        if (task?.project?.workspaceId)
          await applyProviderLabelEvent(
            task.id,
            task.project.workspaceId,
            {
              name: addedLabel.name,
              color: normalizedGiteaLabelColor(addedLabel),
            },
            payload.action === "labeled" ? "add" : "remove",
          );
      }
    } catch (error) {
      console.error("Gitea issue_labeled handler failed for integration", {
        integrationId: integration.id,
        issueNumber: issue.number,
        repository: `${owner}/${repository.name}`,
        error,
      });
      throw error;
    }
  }
}
