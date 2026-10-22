import { eq } from "drizzle-orm";
import db from "../../../database";
import { taskTable } from "../../../database/schema";
import { publishEvent } from "../../../events";
import applyProviderLabelEvent from "../../../label/controllers/apply-provider-label-event";
import { findExternalLink } from "../services/link-manager";
import {
  findAllIntegrationsByRepo,
  updateTaskPriority,
  updateTaskStatus,
} from "../services/task-service";
import {
  extractIssuePriority,
  extractIssueStatus,
} from "../utils/extract-priority";

type IssueLabeledPayload = {
  action: string;
  issue: {
    number: number;
    labels?: Array<string | { name?: string }>;
  };
  label?: {
    name: string;
    color: string;
  };
  repository: {
    owner: { login: string };
    name: string;
  };
};

export async function handleIssueLabeled(payload: IssueLabeledPayload) {
  const { issue, repository, label: addedLabel } = payload;

  const integrations = await findAllIntegrationsByRepo(
    repository.owner.login,
    repository.name,
  );

  for (const integration of integrations) {
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
      const statusResult = await updateTaskStatus(existingLink.taskId, status);
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

    if (!addedLabel) {
      return;
    }

    const isSystemLabel =
      addedLabel.name.startsWith("priority:") ||
      addedLabel.name.startsWith("status:");

    if (isSystemLabel) {
      return;
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
            color: addedLabel.color ? `#${addedLabel.color}` : "#6B7280",
          },
          payload.action === "labeled" ? "add" : "remove",
        );
    }

    return;
  }
}
