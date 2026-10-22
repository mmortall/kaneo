import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const sync = vi.hoisted(() => ({ github: vi.fn(), gitea: vi.fn() }));
vi.mock(
  "../../apps/api/src/plugins/github/utils/sync-label-to-github",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../apps/api/src/plugins/github/utils/sync-label-to-github")
    >()),
    removeLabelFromGitHub: sync.github,
  }),
);
vi.mock(
  "../../apps/api/src/plugins/gitea/utils/sync-label-to-gitea",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../apps/api/src/plugins/gitea/utils/sync-label-to-gitea")
    >()),
    removeLabelFromGitea: sync.gitea,
  }),
);

describe("Individual label task revisions", () => {
  beforeEach(resetTestDatabase);
  beforeEach(() => {
    sync.github.mockReset().mockResolvedValue(undefined);
    sync.gitea.mockReset().mockResolvedValue(undefined);
  });
  async function fixture() {
    const member = await createWorkspaceMember({ role: "owner" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const tasks = await db
      .insert(schema.taskTable)
      .values(
        [1, 2].map((number) => ({
          projectId: project.id,
          number,
          title: `Task ${number}`,
          description: `Prose ${number}`,
          status: "to-do",
          columnId: columns.todo.id,
          goal: "Goal",
          acceptanceCriteria: "Pass",
        })),
      )
      .returning();
    const [label] = await db
      .insert(schema.labelTable)
      .values({
        name: "Label",
        color: "blue",
        workspaceId: member.workspace.id,
      })
      .returning();
    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const attach = (labelId = label!.id, taskId = tasks[0]!.id) =>
      app.request(`/api/label/${labelId}/task`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId }),
      });
    const row = (id: string) =>
      db.query.taskTable.findFirst({ where: eq(schema.taskTable.id, id) });
    const rename = (id: string, name: string, color = "green") =>
      app.request(`/api/label/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, color }),
      });
    return { app, tasks, label: label!, attach, row, rename };
  }
  it("advances revision for attach/detach but not duplicate attachment", async () => {
    const { app, tasks, attach, row } = await fixture();
    const first = await attach();
    expect(first.status).toBe(200);
    const assigned = (await first.json()) as { id: string };
    const after = await row(tasks[0]!.id);
    expect(after).toEqual({
      ...tasks[0],
      version: tasks[0]!.version + 1,
      updatedAt: after!.updatedAt,
    });
    expect((await attach()).status).toBe(200);
    expect(await row(tasks[0]!.id)).toEqual(after);
    const removed = await app.request(`/api/label/${assigned.id}/task`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect((await row(tasks[0]!.id))!.version).toBe(after!.version + 1);
    expect(await row(tasks[1]!.id)).toEqual(tasks[1]);
  });
  it("sixteen duplicate attachments create one assignment and one revision change", async () => {
    const { tasks, attach, row } = await fixture();
    const responses = await Promise.all(
      Array.from({ length: 16 }, () => attach()),
    );
    expect(responses.map((response) => response.status)).toEqual(
      Array(16).fill(200),
    );
    expect(
      new Set(
        (await Promise.all(responses.map((response) => response.json()))).map(
          (label) => label.id,
        ),
      ).size,
    ).toBe(1);
    expect(await db.select().from(schema.labelTable)).toHaveLength(2);
    expect((await row(tasks[0]!.id))!.version).toBe(tasks[0]!.version + 1);
  });
  it("moving an assignment advances source and destination revisions", async () => {
    const { tasks, attach, row } = await fixture();
    const assigned = (await (await attach()).json()) as { id: string };
    const source = await row(tasks[0]!.id);
    const response = await attach(assigned.id, tasks[1]!.id);
    expect(response.status).toBe(200);
    expect((await row(tasks[0]!.id))!.version).toBe(source!.version + 1);
    expect((await row(tasks[1]!.id))!.version).toBe(tasks[1]!.version + 1);
    for (const task of tasks)
      expect((await row(task.id))!.description).toBe(task.description);
  });
  it("attachment invalidates prior bulk snapshots without partial field writes", async () => {
    const { app, tasks, attach, row } = await fixture();
    expect((await attach()).status).toBe(200);
    const before = await Promise.all(tasks.map((task) => row(task.id)));
    const response = await app.request("/api/task/bulk", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskIds: tasks.map((task) => task.id),
        expectedVersions: tasks.map((task) => ({
          id: task.id,
          version: task.version,
        })),
        operation: "updatePriority",
        value: "high",
      }),
    });
    expect(response.status).toBe(409);
    expect(await Promise.all(tasks.map((task) => row(task.id)))).toEqual(
      before,
    );
  });
  it("rolls back without revision change when delete returns no row", async () => {
    const { app, tasks, attach, row } = await fixture();
    const assigned = (await (await attach()).json()) as { id: string };
    const before = await row(tasks[0]!.id);
    await db.execute(
      sql.raw(
        "CREATE FUNCTION kaneo_test_skip_label_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$",
      ),
    );
    try {
      await db.execute(
        sql.raw(
          "CREATE TRIGGER kaneo_test_skip_label_delete BEFORE DELETE ON label FOR EACH ROW EXECUTE FUNCTION kaneo_test_skip_label_delete()",
        ),
      );
      const response = await app.request(`/api/label/${assigned.id}/task`, {
        method: "DELETE",
      });
      expect(response.status).toBe(500);
      expect(await row(tasks[0]!.id)).toEqual(before);
      expect(
        await db.query.labelTable.findFirst({
          where: eq(schema.labelTable.id, assigned.id),
        }),
      ).toBeDefined();
    } finally {
      await db.execute(
        sql.raw("DROP TRIGGER IF EXISTS kaneo_test_skip_label_delete ON label"),
      );
      await db.execute(sql.raw("DROP FUNCTION kaneo_test_skip_label_delete()"));
    }
  });
  it("renames workspace copies and advances only changed tasks, with stable no-op revisions", async () => {
    const { tasks, label, attach, row, rename } = await fixture();
    for (const task of tasks)
      expect((await attach(label.id, task.id)).status).toBe(200);
    const before = await Promise.all(tasks.map((task) => row(task.id)));
    expect((await rename(label.id, "Renamed")).status).toBe(200);
    const after = await Promise.all(tasks.map((task) => row(task.id)));
    for (const [index, task] of after.entries())
      expect(task).toEqual({
        ...before[index],
        version: before[index]!.version + 1,
        updatedAt: task!.updatedAt,
      });
    for (const copy of await db.select().from(schema.labelTable))
      expect(copy).toMatchObject({ name: "Renamed", color: "green" });
    const labelsBeforeNoop = await db
      .select()
      .from(schema.labelTable)
      .orderBy(schema.labelTable.id);
    expect((await rename(label.id, "Renamed")).status).toBe(200);
    expect(await Promise.all(tasks.map((task) => row(task.id)))).toEqual(after);
    expect(
      await db.select().from(schema.labelTable).orderBy(schema.labelTable.id),
    ).toEqual(labelsBeforeNoop);
  });
  it("renames individual copy without changing workspace definition or other task", async () => {
    const { tasks, label, attach, row, rename } = await fixture();
    const assigned = (await (await attach()).json()) as { id: string };
    const before = await row(tasks[0]!.id);
    expect((await rename(assigned.id, "Private")).status).toBe(200);
    expect((await row(tasks[0]!.id))!.version).toBe(before!.version + 1);
    expect(await row(tasks[1]!.id)).toEqual(tasks[1]);
    expect(
      await db.query.labelTable.findFirst({
        where: eq(schema.labelTable.id, label.id),
      }),
    ).toEqual(label);
  });
  it("concurrent workspace renames leave complete consistent copies and revisions", async () => {
    const { tasks, label, attach, row, rename } = await fixture();
    for (const task of tasks)
      expect((await attach(label.id, task.id)).status).toBe(200);
    const before = await Promise.all(tasks.map((task) => row(task.id)));
    const responses = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        rename(label.id, `Rename-${index}`),
      ),
    );
    for (const response of responses)
      expect([200, 409]).toContain(response.status);
    const committed = responses.filter(
      (response) => response.status === 200,
    ).length;
    expect(committed).toBeGreaterThan(0);
    const definition = await db.query.labelTable.findFirst({
      where: eq(schema.labelTable.id, label.id),
    });
    for (const copy of await db.select().from(schema.labelTable))
      expect(copy.name).toBe(definition!.name);
    for (const [index, task] of (
      await Promise.all(tasks.map((task) => row(task.id)))
    ).entries())
      expect(task!.version).toBe(before[index]!.version + committed);
  });
  it("repairs mismatched copy colors without touching already matching tasks", async () => {
    const { tasks, label, attach, row, rename } = await fixture();
    const assigned = (await (await attach()).json()) as { id: string };
    expect((await attach(label.id, tasks[1]!.id)).status).toBe(200);
    await db
      .update(schema.labelTable)
      .set({ color: "red" })
      .where(eq(schema.labelTable.id, assigned.id));
    const before = await Promise.all(tasks.map((task) => row(task.id)));
    expect((await rename(label.id, label.name, label.color)).status).toBe(200);
    expect((await row(tasks[0]!.id))!.version).toBe(before[0]!.version + 1);
    expect(await row(tasks[1]!.id)).toEqual(before[1]);
  });
  it("concurrent task label creation commits one label and one revision increment", async () => {
    const { app, tasks, label, row } = await fixture();
    const create = () =>
      app.request("/api/label", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Created",
          color: "blue",
          taskId: tasks[0]!.id,
          workspaceId: label.workspaceId,
        }),
      });
    const responses = await Promise.all(Array.from({ length: 16 }, create));
    expect(responses.map((response) => response.status)).toEqual(
      Array(16).fill(200),
    );
    expect(
      new Set(
        (await Promise.all(responses.map((response) => response.json()))).map(
          (label) => label.id,
        ),
      ).size,
    ).toBe(1);
    const after = await row(tasks[0]!.id);
    expect(after).toEqual({
      ...tasks[0],
      version: tasks[0]!.version + 1,
      updatedAt: after!.updatedAt,
    });
    expect(await row(tasks[1]!.id)).toEqual(tasks[1]);
    expect((await create()).status).toBe(200);
    expect(await row(tasks[0]!.id)).toEqual(after);
  });
  it("workspace definition creation and replay leave task revisions unchanged", async () => {
    const { app, tasks, label, row } = await fixture();
    const create = () =>
      app.request("/api/label", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Created",
          color: "blue",
          workspaceId: label.workspaceId,
        }),
      });
    const first = await create();
    const second = await create();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toEqual(await second.json());
    expect(await Promise.all(tasks.map((task) => row(task.id)))).toEqual(tasks);
  });
  it("deletes workspace label and copies atomically with post-commit sync and stale bulk rejection", async () => {
    const { app, tasks, label, attach, row } = await fixture();
    for (const task of tasks)
      expect((await attach(label.id, task.id)).status).toBe(200);
    const before = await Promise.all(tasks.map((task) => row(task.id)));
    for (const mock of [sync.github, sync.gitea])
      mock.mockImplementation((id: string) =>
        db
          .select()
          .from(schema.labelTable)
          .where(eq(schema.labelTable.taskId, id)),
      );
    const response = await app.request(`/api/label/${label.id}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: label.id });
    expect(await db.select().from(schema.labelTable)).toEqual([]);
    const after = await Promise.all(tasks.map((task) => row(task.id)));
    for (const [index, task] of after.entries())
      expect(task).toEqual({
        ...before[index],
        version: before[index]!.version + 1,
        updatedAt: task!.updatedAt,
      });
    for (const mock of [sync.github, sync.gitea]) {
      expect(mock).toHaveBeenCalledTimes(2);
      for (const result of mock.mock.results)
        expect(await result.value).toEqual([]);
    }
    const stale = await app.request("/api/task/bulk", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskIds: tasks.map((task) => task.id),
        expectedVersions: before.map((task) => ({
          id: task!.id,
          version: task!.version,
        })),
        operation: "updatePriority",
        value: "high",
      }),
    });
    expect(stale.status).toBe(409);
    expect(await Promise.all(tasks.map((task) => row(task.id)))).toEqual(after);
  });
  it("deletes one task copy while preserving catalog and other task", async () => {
    const { app, tasks, label, attach, row } = await fixture();
    const assigned = (await (await attach()).json()) as { id: string };
    const before = await row(tasks[0]!.id);
    expect(
      (await app.request(`/api/label/${assigned.id}`, { method: "DELETE" }))
        .status,
    ).toBe(200);
    expect((await row(tasks[0]!.id))!.version).toBe(before!.version + 1);
    expect(await row(tasks[1]!.id)).toEqual(tasks[1]);
    expect(
      await db.query.labelTable.findFirst({
        where: eq(schema.labelTable.id, label.id),
      }),
    ).toEqual(label);
  });
  it("concurrent workspace deletions commit one cascade and one revision change", async () => {
    const { app, tasks, label, attach, row } = await fixture();
    for (const task of tasks)
      expect((await attach(label.id, task.id)).status).toBe(200);
    const before = await Promise.all(tasks.map((task) => row(task.id)));
    const responses = await Promise.all(
      Array.from({ length: 16 }, () =>
        app.request(`/api/label/${label.id}`, { method: "DELETE" }),
      ),
    );
    expect(
      responses.filter((response) => response.status === 200),
    ).toHaveLength(1);
    for (const response of responses)
      expect([200, 404, 409]).toContain(response.status);
    expect(await db.select().from(schema.labelTable)).toEqual([]);
    for (const [index, task] of (
      await Promise.all(tasks.map((task) => row(task.id)))
    ).entries())
      expect(task!.version).toBe(before[index]!.version + 1);
    expect(sync.github).toHaveBeenCalledTimes(2);
    expect(sync.gitea).toHaveBeenCalledTimes(2);
  });
  it("rolls back catalog deletion when task-copy deletion is suppressed", async () => {
    const { app, tasks, label, attach, row } = await fixture();
    for (const task of tasks)
      expect((await attach(label.id, task.id)).status).toBe(200);
    const beforeTasks = await Promise.all(tasks.map((task) => row(task.id)));
    const beforeLabels = await db
      .select()
      .from(schema.labelTable)
      .orderBy(schema.labelTable.id);
    await db.execute(
      sql.raw(
        "CREATE FUNCTION kaneo_test_skip_label_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.task_id IS NOT NULL THEN RETURN NULL; END IF; RETURN OLD; END; $$",
      ),
    );
    try {
      await db.execute(
        sql.raw(
          "CREATE TRIGGER kaneo_test_skip_label_delete BEFORE DELETE ON label FOR EACH ROW EXECUTE FUNCTION kaneo_test_skip_label_delete()",
        ),
      );
      const response = await app.request(`/api/label/${label.id}`, {
        method: "DELETE",
      });
      expect(response.status).toBe(409);
      expect(
        await db.select().from(schema.labelTable).orderBy(schema.labelTable.id),
      ).toEqual(beforeLabels);
      expect(await Promise.all(tasks.map((task) => row(task.id)))).toEqual(
        beforeTasks,
      );
      expect(sync.github).not.toHaveBeenCalled();
      expect(sync.gitea).not.toHaveBeenCalled();
    } finally {
      await db.execute(
        sql.raw("DROP TRIGGER IF EXISTS kaneo_test_skip_label_delete ON label"),
      );
      await db.execute(sql.raw("DROP FUNCTION kaneo_test_skip_label_delete()"));
    }
  });
});
