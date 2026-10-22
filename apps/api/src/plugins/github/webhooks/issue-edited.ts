import { findExternalLink } from "../services/link-manager";
import {
  findAllIntegrationsByRepo,
  updateProviderTaskText,
} from "../services/task-service";
import { formatTaskDescriptionFromIssue } from "../utils/format";

type IssueEditedPayload = {
  action: string;
  issue: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
  };
  changes?: {
    title?: {
      from: string;
    };
    body?: {
      from: string;
    };
  };
  repository: {
    owner: { login: string };
    name: string;
    full_name: string;
  };
};

export async function handleIssueEdited(payload: IssueEditedPayload) {
  const { issue, repository, changes } = payload;

  if (!changes?.title && !changes?.body) {
    console.log(
      `Issue #${issue.number} edited but no title/body changes detected`,
    );
    return;
  }

  const integrations = await findAllIntegrationsByRepo(
    repository.owner.login,
    repository.name,
  );

  for (const integration of integrations) {
    const externalLink = await findExternalLink(
      integration.id,
      "issue",
      issue.number.toString(),
    );

    if (!externalLink) {
      continue;
    }

    await updateProviderTaskText(
      externalLink.taskId,
      integration.projectId,
      {
        title: changes.title
          ? { before: changes.title.from, after: issue.title }
          : undefined,
        description: changes.body
          ? {
              before: formatTaskDescriptionFromIssue(
                changes.body.from,
                externalLink.taskId,
              ),
              after: formatTaskDescriptionFromIssue(
                issue.body,
                externalLink.taskId,
              ),
            }
          : undefined,
      },
      {
        linkId: externalLink.id,
        integrationId: integration.id,
        externalId: issue.number.toString(),
        source: "github",
      },
    );

    return;
  }
}
