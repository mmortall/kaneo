import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { handleGiteaPullRequestOpened } from "../../apps/api/src/plugins/gitea/webhooks/pull-request-opened";
import { handleGiteaPush } from "../../apps/api/src/plugins/gitea/webhooks/push";
import { updateTaskStatus } from "../../apps/api/src/plugins/github/services/task-service";
import { handlePullRequestOpened } from "../../apps/api/src/plugins/github/webhooks/pull-request-opened";
import { handlePush } from "../../apps/api/src/plugins/github/webhooks/push";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const lookup = vi.hoisted(() => ({
  github: vi.fn(),
  gitea: vi.fn(),
  link: vi.fn(),
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
    findExternalLink: vi.fn().mockResolvedValue(null),
    createOrUpdateExternalLink: lookup.link,
    createExternalLink: lookup.link,
  }),
);

const repository = {
  owner: { login: "owner" },
  name: "repo",
  html_url: "https://gitea.test/owner/repo",
};
const pushPayload = (ref: string) => ({ ref: `refs/heads/${ref}`, repository });
const prPayload = (ref: string) => ({
  action: "opened",
  repository,
  pull_request: {
    number: 12,
    title: "Work",
    body: null,
    html_url: "https://gitea.test/owner/repo/pulls/12",
    state: "open",
    draft: false,
    merged: false,
    head: { ref },
    user: { login: "user" },
  },
});
const cases = [
  {
    name: "GitHub push",
    run: (ref: string) => handlePush(pushPayload(ref)),
    target: "in-progress",
  },
  {
    name: "Gitea push",
    run: (ref: string) => handleGiteaPush(pushPayload(ref)),
    target: "in-progress",
  },
  {
    name: "GitHub PR opened",
    run: (ref: string) => handlePullRequestOpened(prPayload(ref)),
    target: "in-review",
  },
  {
    name: "Gitea PR opened",
    run: (ref: string) => handleGiteaPullRequestOpened(prPayload(ref)),
    target: "in-review",
  },
];

describe("Provider status transaction guards", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    lookup.link.mockReset();
  });
  async function fixture() {
    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        number: 1,
        title: "Keep title",
        description: "Keep prose",
        status: "to-do",
        columnId: columns.todo.id,
      })
      .returning();
    const integration = {
      id: "integration",
      projectId: project.id,
      project,
      config: JSON.stringify({ branchPattern: "{slug}-{number}" }),
    };
    lookup.github.mockResolvedValue([integration]);
    lookup.gitea.mockResolvedValue([integration]);
    const row = () =>
      db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, task!.id),
      });
    return {
      member,
      project,
      columns,
      task: task!,
      row,
      ref: `${project.slug}-1`,
    };
  }
  it.each(cases)(
    "$name preserves completion committed after handler lookup",
    async ({ run }) => {
      const { task, columns, row, ref } = await fixture();
      let completed: typeof task | undefined;
      lookup.link.mockImplementation(async () => {
        [completed] = await db
          .update(schema.taskTable)
          .set({
            status: "done",
            columnId: columns.done.id,
            completionSummary: "Concurrent work completed",
          })
          .where(eq(schema.taskTable.id, task.id))
          .returning();
      });
      await run(ref);
      expect(lookup.link).toHaveBeenCalledOnce();
      expect(await row()).toEqual(completed);
      expect(completed!.version).toBe(task.version + 1);
    },
  );
  it.each(cases)(
    "$name skips task moved after handler lookup",
    async ({ run }) => {
      const { member, task, row, ref } = await fixture();
      const destination = await createProjectFixture({
        workspaceId: member.workspace.id,
      });
      let moved: typeof task | undefined;
      lookup.link.mockImplementation(async () => {
        [moved] = await db
          .update(schema.taskTable)
          .set({
            projectId: destination.project.id,
            columnId: destination.columns.todo.id,
          })
          .where(eq(schema.taskTable.id, task.id))
          .returning();
      });
      await run(ref);
      expect(await row()).toEqual(moved);
      expect(moved!.version).toBe(task.version + 1);
    },
  );
  it.each(cases)(
    "$name still advances active work once across16 events",
    async ({ run, target }) => {
      const { task, row, ref } = await fixture();
      await Promise.all(Array.from({ length: 16 }, () => run(ref)));
      const after = await row();
      const column = await db.query.columnTable.findFirst({
        where: eq(schema.columnTable.id, after!.columnId!),
      });
      expect(column).toMatchObject({ projectId: task.projectId, slug: target });
      expect(after).toEqual({
        ...task,
        status: target,
        columnId: column!.id,
        version: task.version + 1,
        updatedAt: after!.updatedAt,
      });
    },
  );
  it.each([true, false])(
    "protects custom final column with columnId present=%s",
    async (hasColumnId) => {
      const { task, project, row } = await fixture();
      const [column] = await db
        .insert(schema.columnTable)
        .values({
          projectId: project.id,
          name: "Released",
          slug: "released",
          isFinal: true,
          position: 10,
        })
        .returning();
      await db
        .update(schema.taskTable)
        .set({ status: "released", columnId: hasColumnId ? column!.id : null })
        .where(eq(schema.taskTable.id, task.id));
      const before = await row();
      expect(
        await updateTaskStatus(task.id, "in-progress", {
          onlyIfNotFinal: true,
        }),
      ).toEqual({ applied: false });
      expect(await row()).toEqual(before);
    },
  );
  it("explicit issue reopen remains allowed without non-final guard", async () => {
    const { task, columns, row } = await fixture();
    await db
      .update(schema.taskTable)
      .set({ status: "done", columnId: columns.done.id })
      .where(eq(schema.taskTable.id, task.id));
    const result = await updateTaskStatus(task.id, "to-do");
    expect(result.applied).toBe(true);
    expect((await row())!.status).toBe("to-do");
  });
});
