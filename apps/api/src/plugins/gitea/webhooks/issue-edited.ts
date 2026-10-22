import { findExternalLink } from "../../github/services/link-manager";
import { updateProviderTaskText } from "../../github/services/task-service";
import { formatTaskDescriptionFromIssue } from "../../github/utils/format";
import {
  findAllIntegrationsByGiteaRepo,
  repoOwnerLogin,
} from "../services/integration-lookup";
import { baseUrlFromRepositoryHtmlUrl } from "../utils/webhook-repo";

type IssueEditedPayload = {
  action: string;
  issue: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
  };
  changes?: {
    title?: { from: string };
    body?: { from: string };
  };
  repository: {
    owner: { login?: string; username?: string };
    name: string;
    html_url: string;
  };
};

export async function handleGiteaIssueEdited(
  payload: IssueEditedPayload,
  integrationId?: string,
) {
  const { issue, repository, changes } = payload;

  if (!changes?.title && !changes?.body) {
    return;
  }

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
        source: "gitea",
      },
    );

    return;
  }
}
