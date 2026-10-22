import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { handleTaskDescriptionChanged as giteaBody } from "../../apps/api/src/plugins/gitea/events/task-description-changed";
import { handleTaskTitleChanged as giteaTitle } from "../../apps/api/src/plugins/gitea/events/task-title-changed";
import { handleTaskDescriptionChanged as githubBody } from "../../apps/api/src/plugins/github/events/task-description-changed";
import { handleTaskTitleChanged as githubTitle } from "../../apps/api/src/plugins/github/events/task-title-changed";
import { recordExternalLinkFieldSync } from "../../apps/api/src/plugins/github/services/link-manager";
import { updateProviderTaskText } from "../../apps/api/src/plugins/github/services/task-service";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const remote = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock(
  "../../apps/api/src/plugins/github/utils/github-app",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../apps/api/src/plugins/github/utils/github-app")
    >()),
    getGithubApp: () => ({
      getInstallationOctokit: async () => ({
        rest: { issues: { update: remote.update } },
      }),
    }),
  }),
);
vi.mock(
  "../../apps/api/src/plugins/gitea/utils/gitea-api",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../apps/api/src/plugins/gitea/utils/gitea-api")
    >()),
    createGiteaClient: () => ({ updateIssue: remote.update }),
  }),
);
const cases = [
  {
    name: "GitHub title",
    provider: "github",
    field: "title",
    handler: githubTitle,
  },
  {
    name: "GitHub body",
    provider: "github",
    field: "description",
    handler: githubBody,
  },
  {
    name: "Gitea title",
    provider: "gitea",
    field: "title",
    handler: giteaTitle,
  },
  {
    name: "Gitea body",
    provider: "gitea",
    field: "description",
    handler: giteaBody,
  },
] as const;
describe("Outbound issue field metadata merge", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    remote.update.mockReset();
  });
  async function fixture(provider = "gitea") {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const config = {
      baseUrl: "https://gitea.test",
      accessToken: "unused-test-token",
      repositoryOwner: "owner",
      repositoryName: "repo",
      installationId: 1,
    };
    const [integration] = await db
      .insert(schema.integrationTable)
      .values({
        projectId: project.id,
        type: provider,
        config: JSON.stringify(config),
      })
      .returning();
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Title",
        description: "Body",
        status: "to-do",
      })
      .returning();
    const [link] = await db
      .insert(schema.externalLinkTable)
      .values({
        taskId: task!.id,
        integrationId: integration!.id,
        resourceType: "issue",
        externalId: "1",
        url: "https://gitea.test/owner/repo/issues/1",
        metadata: JSON.stringify({ state: "open", custom: { keep: 1 } }),
      })
      .returning();
    const readLink = () =>
      db.query.externalLinkTable.findFirst({
        where: eq(schema.externalLinkTable.id, link!.id),
      });
    const params = {
      linkId: link!.id,
      taskId: task!.id,
      integrationId: integration!.id,
      externalId: "1",
    };
    const context = {
      integrationId: integration!.id,
      projectId: project.id,
      config,
    };
    return { task: task!, project, link: link!, readLink, params, context };
  }
  it.each(cases)(
    "$name merges after remote call without losing inbound other-field update",
    async ({ provider, field, handler }) => {
      const { task, project, link, readLink, params, context } =
        await fixture(provider);
      await db
        .update(schema.externalLinkTable)
        .set({
          metadata: JSON.stringify({
            state: "open",
            custom: { keep: 1 },
            lastSync: {
              [field]: {
                source: provider,
                value: "Previous provider value",
                timestamp: new Date().toISOString(),
              },
            },
          }),
        })
        .where(eq(schema.externalLinkTable.id, link.id));
      const other = field === "title" ? "description" : "title";
      remote.update.mockImplementation(async () => {
        await updateProviderTaskText(
          task.id,
          project.id,
          { [other]: { before: task[other]!, after: "Parallel field" } },
          { ...params, source: provider },
        );
      });
      const event = {
        taskId: task.id,
        projectId: project.id,
        userId: null,
        oldTitle: "Old title",
        newTitle: "Title",
        oldDescription: "Old body",
        newDescription: "Body",
      };
      await handler(event, context);
      expect(remote.update).toHaveBeenCalledOnce();
      const after = await readLink();
      expect(JSON.parse(after!.metadata!)).toMatchObject({
        state: "open",
        custom: { keep: 1 },
        lastSync: {
          [field]: { source: "kaneo", value: task[field] },
          [other]: { source: provider, value: "Parallel field" },
        },
      });
      expect(after!.title).toBe(field === "title" ? "Title" : "Parallel field");
    },
  );
  it("sixteen interleaved records retain both fields and repeat preserves exact link", async () => {
    const { task, readLink, params } = await fixture();
    await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        recordExternalLinkFieldSync({
          ...params,
          field: i % 2 ? "title" : "description",
          value: i % 2 ? "Title" : "Body",
        }),
      ),
    );
    const after = await readLink();
    expect(JSON.parse(after!.metadata!)).toMatchObject({
      state: "open",
      custom: { keep: 1 },
      lastSync: {
        title: { source: "kaneo", value: "Title" },
        description: { source: "kaneo", value: "Body" },
      },
    });
    await recordExternalLinkFieldSync({
      ...params,
      field: "title",
      value: "Title",
    });
    await recordExternalLinkFieldSync({
      ...params,
      field: "description",
      value: "Body",
    });
    expect(await readLink()).toEqual(after);
    expect(
      await db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, task.id),
      }),
    ).toEqual(task);
  });
  it("changed binding rejects metadata acknowledgement without modifying link", async () => {
    const { link, params, readLink } = await fixture();
    await expect(
      recordExternalLinkFieldSync({
        ...params,
        externalId: "2",
        field: "title",
        value: "Title",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await readLink()).toEqual(link);
  });
  it.each(["{", "null", '{"lastSync":17}'])(
    "malformed stored metadata %s is preserved and rejected",
    async (metadata) => {
      const { link, params, readLink } = await fixture();
      await db
        .update(schema.externalLinkTable)
        .set({ metadata })
        .where(eq(schema.externalLinkTable.id, link.id));
      const before = await readLink();
      await expect(
        recordExternalLinkFieldSync({
          ...params,
          field: "title",
          value: "Title",
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await readLink()).toEqual(before);
    },
  );
});
