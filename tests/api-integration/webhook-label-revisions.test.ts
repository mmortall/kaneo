import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import applyProviderLabelEvent from "../../apps/api/src/label/controllers/apply-provider-label-event";
import {
  handleGiteaIssueLabeled,
  syncGiteaLabelsToTask,
} from "../../apps/api/src/plugins/gitea/webhooks/issue-labeled";
import {
  updateTaskPriority,
  updateTaskStatus,
} from "../../apps/api/src/plugins/github/services/task-service";
import { handleIssueLabeled } from "../../apps/api/src/plugins/github/webhooks/issue-labeled";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const lookup = vi.hoisted(() => ({
  link: vi.fn(),
  github: vi.fn(),
  gitea: vi.fn(),
}));
vi.mock(
  "../../apps/api/src/plugins/github/services/link-manager",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../apps/api/src/plugins/github/services/link-manager")
    >()),
    findExternalLink: lookup.link,
  }),
);
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
describe("Issue label webhook revisions", () => {
  beforeEach(resetTestDatabase);
  async function fixture() {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Task",
        description: "Keep prose",
        status: "to-do",
      })
      .returning();
    lookup.link.mockResolvedValue({ taskId: task!.id });
    lookup.github.mockResolvedValue([{ id: "integration" }]);
    lookup.gitea.mockResolvedValue([{ id: "integration" }]);
    const payload = {
      action: "labeled",
      issue: { number: 1, labels: [] },
      label: { name: "New", color: "aabbcc" },
      repository: {
        owner: { login: "owner" },
        name: "repo",
        html_url: "https://gitea.test/owner/repo",
      },
    };
    const row = () =>
      db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, task!.id),
      });
    return { member, task: task!, payload, row };
  }
  it.each([handleIssueLabeled, handleGiteaIssueLabeled])(
    "handler applies add/remove once and preserves unrelated fields",
    async (handler) => {
      const { task, payload, row } = await fixture();
      await handler(payload);
      const added = await row();
      expect(added).toEqual({
        ...task,
        version: task.version + 1,
        updatedAt: added!.updatedAt,
      });
      await handler(payload);
      expect(await row()).toEqual(added);
      expect(await db.select().from(schema.labelTable)).toHaveLength(1);
      await handler({ ...payload, action: "unlabeled" });
      const removed = await row();
      expect(removed).toEqual({
        ...added,
        version: added!.version + 1,
        updatedAt: removed!.updatedAt,
      });
      await handler({ ...payload, action: "unlabeled" });
      expect(await row()).toEqual(removed);
      expect(await db.select().from(schema.labelTable)).toEqual([]);
    },
  );
  it.each([handleIssueLabeled, handleGiteaIssueLabeled])(
    "sixteen duplicate events commit one label and one revision",
    async (handler) => {
      const { task, payload, row } = await fixture();
      await Promise.all(Array.from({ length: 16 }, () => handler(payload)));
      expect(await db.select().from(schema.labelTable)).toHaveLength(1);
      expect((await row())!.version).toBe(task.version + 1);
    },
  );
  it("rejects wrong workspace without label or revision changes", async () => {
    const { task, row } = await fixture();
    await expect(
      applyProviderLabelEvent(
        task.id,
        "wrong-workspace",
        { name: "New", color: "blue" },
        "add",
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await row()).toEqual(task);
    expect(await db.select().from(schema.labelTable)).toEqual([]);
  });
  it.each([handleIssueLabeled, handleGiteaIssueLabeled])(
    "sixteen duplicate priority/status events change each field once",
    async (handler) => {
      const { task, payload, row } = await fixture();
      const event = {
        ...payload,
        label: { name: "priority:high", color: "aabbcc" },
        issue: { number: 1, labels: ["priority:high", "status:in-progress"] },
      };
      await Promise.all(Array.from({ length: 16 }, () => handler(event)));
      const after = await row();
      const column = await db.query.columnTable.findFirst({
        where: eq(schema.columnTable.id, after!.columnId!),
      });
      expect(column).toMatchObject({
        projectId: task.projectId,
        slug: "in-progress",
      });
      expect(after).toEqual({
        ...task,
        status: "in-progress",
        columnId: column!.id,
        priority: "high",
        version: task.version + 2,
        updatedAt: after!.updatedAt,
      });
      await handler(event);
      expect(await row()).toEqual(after);
      expect(await db.select().from(schema.labelTable)).toEqual([]);
    },
  );
  it("missing tasks and unknown columns do not mutate task; column repair happens once", async () => {
    const { task, row } = await fixture();
    expect(await updateTaskStatus("missing", "done")).toEqual({
      applied: false,
    });
    expect(await updateTaskPriority("missing", "high")).toBe(false);
    expect(await updateTaskStatus(task.id, "unknown-status")).toEqual({
      applied: false,
    });
    expect(await row()).toEqual(task);
    const results = await Promise.all(
      Array.from({ length: 16 }, () => updateTaskStatus(task.id, "to-do")),
    );
    expect(results.filter((result) => result.applied)).toHaveLength(1);
    const after = await row();
    expect(after!.version).toBe(task.version + 1);
    expect(after!.columnId).not.toBeNull();
    const applied = results.find((result) => result.applied)!;
    expect(applied).toEqual({ applied: true, before: task, after });
  });
  it("status resolution waits for concurrent project move and uses destination column", async () => {
    const { member, task, row } = await fixture();
    const destination = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lockReady = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const move = db.transaction(async (tx) => {
      await tx
        .select()
        .from(schema.taskTable)
        .where(eq(schema.taskTable.id, task.id))
        .for("update");
      locked();
      await gate;
      await tx
        .update(schema.taskTable)
        .set({ projectId: destination.project.id, columnId: null })
        .where(eq(schema.taskTable.id, task.id));
    });
    await lockReady;
    const statusChange = updateTaskStatus(task.id, "in-progress");
    try {
      let waiting = false;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !waiting) {
        const result =
          await db.execute(sql`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%"task"%' AND query LIKE '%for update%'`);
        waiting = Number(result.rows[0]?.count) > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(true);
    } finally {
      release();
      await Promise.all([move, statusChange]);
    }
    await move;
    const result = await statusChange;
    expect(result.applied).toBe(true);
    if (!result.applied) throw new Error("Expected committed transition");
    expect(result.before.projectId).toBe(destination.project.id);
    expect(result.before.version).toBe(task.version + 1);
    const column = await db.query.columnTable.findFirst({
      where: eq(schema.columnTable.id, result.after.columnId!),
    });
    expect(column).toMatchObject({
      projectId: destination.project.id,
      slug: "in-progress",
    });
    expect(await row()).toEqual(result.after);
  });
  it("Gitea set sync changes colors and membership atomically while preserving system labels", async () => {
    const { member, task, payload, row } = await fixture();
    await db.insert(schema.labelTable).values(
      [
        { name: "Old", color: "#aaaaaa" },
        { name: "Kept", color: "#bbbbbb" },
        { name: "priority:low", color: "#cccccc" },
      ].map((label) => ({
        ...label,
        taskId: task.id,
        workspaceId: member.workspace.id,
      })),
    );
    const event = {
      ...payload,
      action: "label_updated",
      issue: {
        number: 1,
        labels: [
          { name: "Kept", color: "dddddd" },
          { name: "New", color: "eeeeee" },
        ],
      },
    };
    await handleGiteaIssueLabeled(event);
    const after = await row();
    expect(after).toEqual({
      ...task,
      version: task.version + 1,
      updatedAt: after!.updatedAt,
    });
    const labels = await db
      .select()
      .from(schema.labelTable)
      .orderBy(schema.labelTable.name);
    expect(labels.map((label) => [label.name, label.color])).toEqual([
      ["Kept", "#dddddd"],
      ["New", "#eeeeee"],
      ["priority:low", "#cccccc"],
    ]);
    await handleGiteaIssueLabeled(event);
    expect(await row()).toEqual(after);
    expect(
      await db.select().from(schema.labelTable).orderBy(schema.labelTable.name),
    ).toEqual(labels);
  });
  it("sixteen Gitea set syncs make one revision change", async () => {
    const { task, payload, row } = await fixture();
    const event = {
      ...payload,
      action: "label_updated",
      issue: { number: 1, labels: [{ name: "New", color: "aabbcc" }] },
    };
    await Promise.all(
      Array.from({ length: 16 }, () => handleGiteaIssueLabeled(event)),
    );
    expect((await row())!.version).toBe(task.version + 1);
    expect(await db.select().from(schema.labelTable)).toHaveLength(1);
  });
  it("Gitea equivalent color representations and absent label set preserve revision", async () => {
    const { member, task, payload, row } = await fixture();
    await db.insert(schema.labelTable).values({
      name: "Kept",
      color: "aabbcc",
      taskId: task.id,
      workspaceId: member.workspace.id,
    });
    await handleGiteaIssueLabeled({
      ...payload,
      action: "label_updated",
      issue: { number: 1, labels: [{ name: "Kept", color: "#aabbcc" }] },
    });
    expect(await row()).toEqual(task);
    await handleGiteaIssueLabeled({
      ...payload,
      action: "label_updated",
      issue: { number: 1 },
    });
    expect(await row()).toEqual(task);
  });
  it("Gitea sync rolls back earlier color update when insert fails", async () => {
    const { member, task, row } = await fixture();
    await db.insert(schema.labelTable).values({
      name: "Kept",
      color: "#aaaaaa",
      taskId: task.id,
      workspaceId: member.workspace.id,
    });
    const before = await db.select().from(schema.labelTable);
    await db.execute(
      sql.raw(
        "CREATE FUNCTION kaneo_test_fail_label_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Controlled insert failure'; END; $$",
      ),
    );
    try {
      await db.execute(
        sql.raw(
          "CREATE TRIGGER kaneo_test_fail_label_insert BEFORE INSERT ON label FOR EACH ROW EXECUTE FUNCTION kaneo_test_fail_label_insert()",
        ),
      );
      await expect(
        syncGiteaLabelsToTask(task.id, member.workspace.id, [
          { name: "Kept", color: "bbbbbb" },
          { name: "New", color: "cccccc" },
        ]),
      ).rejects.toThrow();
      expect(await db.select().from(schema.labelTable)).toEqual(before);
      expect(await row()).toEqual(task);
    } finally {
      await db.execute(
        sql.raw("DROP TRIGGER IF EXISTS kaneo_test_fail_label_insert ON label"),
      );
      await db.execute(sql.raw("DROP FUNCTION kaneo_test_fail_label_insert()"));
    }
  });
});
