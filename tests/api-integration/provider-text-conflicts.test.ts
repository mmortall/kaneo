import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { handleGiteaIssueEdited } from "../../apps/api/src/plugins/gitea/webhooks/issue-edited";
import { updateProviderTaskText } from "../../apps/api/src/plugins/github/services/task-service";
import { formatIssueBody } from "../../apps/api/src/plugins/github/utils/format";
import { handleIssueEdited } from "../../apps/api/src/plugins/github/webhooks/issue-edited";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const lookup = vi.hoisted(() => ({
  github: vi.fn(),
  gitea: vi.fn(),
  link: vi.fn(),
  updateLink: vi.fn(),
}));
vi.mock(
  "../../apps/api/src/plugins/github/services/task-service",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../apps/api/src/plugins/github/services/task-service")
    >()),
    findAllIntegrationsByRepo: lookup.github,
  }),
);
vi.mock(
  "../../apps/api/src/plugins/gitea/services/integration-lookup",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../apps/api/src/plugins/gitea/services/integration-lookup")
    >()),
    findAllIntegrationsByGiteaRepo: lookup.gitea,
  }),
);
vi.mock(
  "../../apps/api/src/plugins/github/services/link-manager",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../apps/api/src/plugins/github/services/link-manager")
    >()),
    findExternalLink: lookup.link,
    updateExternalLink: lookup.updateLink,
  }),
);
const handlers = [
  { name: "GitHub", handler: handleIssueEdited },
  { name: "Gitea", handler: handleGiteaIssueEdited },
];
describe("Provider issue text conflicts", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    lookup.updateLink.mockReset();
  });
  async function fixture() {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Old title",
        description: "Old body",
        status: "blocked",
        blockedReason: "Keep reason",
        unblockPolicy: "human_required",
      })
      .returning();
    const [integration] = await db
      .insert(schema.integrationTable)
      .values({ projectId: project.id, type: "gitea", config: "{}" })
      .returning();
    lookup.github.mockResolvedValue([integration]);
    lookup.gitea.mockResolvedValue([integration]);
    const [link] = await db
      .insert(schema.externalLinkTable)
      .values({
        taskId: task!.id,
        integrationId: integration!.id,
        resourceType: "issue",
        externalId: "1",
        url: "https://gitea.test/owner/repo/issues/1",
        metadata: "{}",
      })
      .returning();
    lookup.link.mockResolvedValue(link);
    const payload = {
      action: "edited",
      issue: {
        number: 1,
        title: "New title",
        body: "New body",
        html_url: "https://gitea.test/owner/repo/issues/1",
      },
      changes: { title: { from: "Old title" }, body: { from: "Old body" } },
      repository: {
        owner: { login: "owner" },
        name: "repo",
        full_name: "owner/repo",
        html_url: "https://gitea.test/owner/repo",
      },
    };
    const row = () =>
      db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, task!.id),
      });
    return { member, project, task: task!, link, payload, row };
  }
  it.each(handlers)(
    "$name applies title/body once across16 identical deliveries",
    async ({ handler }) => {
      const { task, payload, row } = await fixture();
      await Promise.all(Array.from({ length: 16 }, () => handler(payload)));
      const after = await row();
      expect(after).toEqual({
        ...task,
        title: "New title",
        description: "New body",
        version: task.version + 1,
        updatedAt: after!.updatedAt,
      });
      await handler(payload);
      expect(await row()).toEqual(after);
    },
  );
  it.each(handlers)(
    "$name rejects divergent body atomically without writing valid title",
    async ({ handler }) => {
      const { task, payload, row } = await fixture();
      await db
        .update(schema.taskTable)
        .set({ description: "Agent body" })
        .where(eq(schema.taskTable.id, task.id));
      const before = await row();
      await expect(handler(payload)).rejects.toMatchObject({ status: 409 });
      expect(await row()).toEqual(before);
      expect(lookup.updateLink).not.toHaveBeenCalled();
    },
  );
  it.each(handlers)(
    "$name accepts separate rapid edit despite recent sync metadata",
    async ({ handler, name }) => {
      const { task, link, payload, row } = await fixture();
      await db
        .update(schema.externalLinkTable)
        .set({
          metadata: JSON.stringify({
            lastSync: {
              title: {
                timestamp: new Date().toISOString(),
                source: name.toLowerCase(),
                value: task.title,
              },
            },
          }),
        })
        .where(eq(schema.externalLinkTable.id, link!.id));
      await handler({ ...payload, changes: { title: payload.changes.title } });
      const after = await row();
      expect(after).toEqual({
        ...task,
        title: "New title",
        version: task.version + 1,
        updatedAt: after!.updatedAt,
      });
    },
  );
  it.each(handlers)(
    "$name exposes15 conflicts for16 competing title changes",
    async ({ handler }) => {
      const { task, payload, row } = await fixture();
      const results = await Promise.allSettled(
        Array.from({ length: 16 }, (_, index) =>
          handler({
            ...payload,
            issue: { ...payload.issue, title: `Title ${index}` },
            changes: { title: payload.changes.title },
          }),
        ),
      );
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const conflicts = results.filter(
        (result) => result.status === "rejected",
      );
      expect(conflicts).toHaveLength(15);
      for (const result of conflicts)
        if (result.status === "rejected")
          expect(result.reason).toMatchObject({ status: 409 });
      const after = await row();
      expect(after!.version).toBe(task.version + 1);
      expect(after!.description).toBe(task.description);
      const link = await db.query.externalLinkTable.findFirst({
        where: eq(schema.externalLinkTable.taskId, task.id),
      });
      expect(JSON.parse(link!.metadata!).lastSync.title.value).toBe(
        after!.title,
      );
      expect(lookup.updateLink).not.toHaveBeenCalled();
    },
  );
  it.each(handlers)(
    "$name preserves unrelated concurrent fields",
    async ({ handler }) => {
      const { task, payload, row } = await fixture();
      await db
        .update(schema.taskTable)
        .set({ priority: "urgent", completionSummary: "Keep summary" })
        .where(eq(schema.taskTable.id, task.id));
      const before = await row();
      await handler(payload);
      const after = await row();
      expect(after).toEqual({
        ...before,
        title: "New title",
        description: "New body",
        version: before!.version + 1,
        updatedAt: after!.updatedAt,
      });
    },
  );
  it.each(handlers)(
    "$name rejects moved task without metadata update",
    async ({ handler }) => {
      const { member, task, payload, row } = await fixture();
      const destination = await createProjectFixture({
        workspaceId: member.workspace.id,
      });
      await db
        .update(schema.taskTable)
        .set({ projectId: destination.project.id })
        .where(eq(schema.taskTable.id, task.id));
      const before = await row();
      await expect(handler(payload)).rejects.toMatchObject({ status: 409 });
      expect(await row()).toEqual(before);
      expect(lookup.updateLink).not.toHaveBeenCalled();
    },
  );
  it("nullable empty description replay preserves exact row and conflict reports revision", async () => {
    const { task, project, row } = await fixture();
    await db
      .update(schema.taskTable)
      .set({ description: null })
      .where(eq(schema.taskTable.id, task.id));
    const before = await row();
    expect(
      await updateProviderTaskText(task.id, project.id, {
        description: { before: "", after: "" },
      }),
    ).toEqual({ applied: false });
    expect(await row()).toEqual(before);
    try {
      await updateProviderTaskText(task.id, project.id, {
        title: { before: "Wrong title", after: "Remote title" },
      });
      throw new Error("Expected conflict");
    } catch (error) {
      expect(error).toMatchObject({ status: 409 });
      const response = (error as { getResponse: () => Response }).getResponse();
      expect(await response.json()).toMatchObject({
        error: "TASK_CONFLICT",
        field: "title",
        currentVersion: before!.version,
      });
    }
  });
  it.each(handlers)(
    "$name rejects link binding changed since discovery",
    async ({ handler }) => {
      const { task, link, payload, row } = await fixture();
      await db
        .update(schema.externalLinkTable)
        .set({ externalId: "2" })
        .where(eq(schema.externalLinkTable.id, link!.id));
      const beforeLink = await db.query.externalLinkTable.findFirst({
        where: eq(schema.externalLinkTable.id, link!.id),
      });
      await expect(handler(payload)).rejects.toMatchObject({ status: 409 });
      expect(await row()).toEqual(task);
      expect(
        await db.query.externalLinkTable.findFirst({
          where: eq(schema.externalLinkTable.id, link!.id),
        }),
      ).toEqual(beforeLink);
    },
  );
  it.each(handlers)(
    "$name normalizes body footer echo and preserves exact task/link",
    async ({ handler }) => {
      const { task, link, payload, row } = await fixture();
      await db
        .update(schema.externalLinkTable)
        .set({
          metadata: JSON.stringify({
            lastSync: {
              description: {
                source: "kaneo",
                value: task.description,
                timestamp: "2026-01-01T00:00:00Z",
              },
            },
          }),
        })
        .where(eq(schema.externalLinkTable.id, link!.id));
      const beforeLink = await db.query.externalLinkTable.findFirst({
        where: eq(schema.externalLinkTable.id, link!.id),
      });
      await handler({
        ...payload,
        issue: {
          ...payload.issue,
          body: formatIssueBody(task.description, task.id),
        },
        changes: { body: { from: "Previous provider body" } },
      });
      expect(await row()).toEqual(task);
      expect(
        await db.query.externalLinkTable.findFirst({
          where: eq(schema.externalLinkTable.id, link!.id),
        }),
      ).toEqual(beforeLink);
    },
  );
});
