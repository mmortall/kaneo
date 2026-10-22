import { eq } from "drizzle-orm";
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

describe("Versioned selected bulk task fields", () => {
  beforeEach(resetTestDatabase);
  beforeEach(() => vi.clearAllMocks());
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
          priority: "low",
        })),
      )
      .returning();
    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const request = (
      operation: string,
      value: string | null,
      versions = tasks.map((task) => ({ id: task.id, version: task.version })),
    ) =>
      app.request("/api/task/bulk", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-kaneo-caller": "ai" },
        body: JSON.stringify({
          taskIds: tasks.map((task) => task.id),
          operation,
          value,
          expectedVersions: versions,
        }),
      });
    const rows = () =>
      db
        .select()
        .from(schema.taskTable)
        .where(eq(schema.taskTable.projectId, project.id))
        .orderBy(schema.taskTable.id);
    return { member, tasks, request, rows };
  }

  it.each([
    "updateStatus",
    "updatePriority",
    "updateAssignee",
    "updateDueDate",
  ])("guards %s while preserving prose", async (operation) => {
    const { member, tasks, request, rows } = await fixture();
    const value =
      operation === "updateStatus"
        ? "planned"
        : operation === "updatePriority"
          ? "high"
          : operation === "updateAssignee"
            ? member.user.id
            : "2026-10-09T00:00:00Z";
    const response = await request(operation, value);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, updatedCount: 2 });
    const after = await rows();
    for (const row of after) {
      const original = tasks.find((task) => task.id === row.id)!;
      expect(row.version).toBe(original.version + 1);
      expect(row.description).toBe(original.description);
      const actual =
        operation === "updateStatus"
          ? row.status
          : operation === "updatePriority"
            ? row.priority
            : operation === "updateAssignee"
              ? row.userId
              : row.dueDate?.toISOString();
      expect(actual).toBe(
        operation === "updateDueDate" ? new Date(value).toISOString() : value,
      );
    }
    expect((await request(operation, value)).status).toBe(409);
    expect(await rows()).toEqual(after);
  });

  it("rejects whole selection when one task changed", async () => {
    const { tasks, request, rows } = await fixture();
    await db
      .update(schema.taskTable)
      .set({ description: "Newer agent prose" })
      .where(eq(schema.taskTable.id, tasks[0]!.id));
    const before = await rows();
    const response = await request("updatePriority", "high");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "TASK_CONFLICT" });
    expect(await rows()).toEqual(before);
  });

  it("commits exactly one of sixteen same-snapshot selections", async () => {
    const { tasks, request, rows } = await fixture();
    const responses = await Promise.all(
      Array.from({ length: 16 }, () => request("updatePriority", "high")),
    );
    expect(
      responses.filter((response) => response.status === 200),
    ).toHaveLength(1);
    expect(
      responses.filter((response) => response.status === 409),
    ).toHaveLength(15);
    for (const row of await rows()) {
      expect(row.version).toBe(
        tasks.find((task) => task.id === row.id)!.version + 1,
      );
      expect(row.priority).toBe("high");
    }
  });

  it("rejects incomplete, duplicate or foreign revision sets without mutation", async () => {
    const { tasks, request, rows } = await fixture();
    const before = await rows();
    const snapshots = tasks.map((task) => ({
      id: task.id,
      version: task.version,
    }));
    for (const versions of [
      snapshots.slice(0, 1),
      [snapshots[0]!, snapshots[0]!],
      [snapshots[0]!, { id: "foreign", version: 1 }],
    ])
      expect((await request("updatePriority", "high", versions)).status).toBe(
        400,
      );
    expect(await rows()).toEqual(before);
  });

  it("adds labels atomically, advances revisions and leaves no-op versions unchanged", async () => {
    const { member, tasks, request, rows } = await fixture();
    const [label] = await db
      .insert(schema.labelTable)
      .values({ name: "Bulk", color: "blue", workspaceId: member.workspace.id })
      .returning();
    const responses = await Promise.all(
      Array.from({ length: 16 }, () => request("addLabel", label!.id)),
    );
    expect(
      responses.filter((response) => response.status === 200),
    ).toHaveLength(1);
    expect(
      responses.filter((response) => response.status === 409),
    ).toHaveLength(15);
    expect(await db.select().from(schema.labelTable)).toHaveLength(3);
    const after = await rows();
    for (const row of after)
      expect(row.version).toBe(
        tasks.find((task) => task.id === row.id)!.version + 1,
      );
    const noop = await request(
      "addLabel",
      label!.id,
      after.map((task) => ({ id: task.id, version: task.version })),
    );
    expect(noop.status).toBe(200);
    expect(await noop.json()).toEqual({ success: true, updatedCount: 0 });
    expect(await rows()).toEqual(after);
  });

  it("removes labels and starts external sync only after commit", async () => {
    const { member, tasks, request, rows } = await fixture();
    const [label] = await db
      .insert(schema.labelTable)
      .values({ name: "Bulk", color: "blue", workspaceId: member.workspace.id })
      .returning();
    await db.insert(schema.labelTable).values(
      tasks.map((task) => ({
        name: label!.name,
        color: "blue",
        workspaceId: member.workspace.id,
        taskId: task.id,
      })),
    );
    for (const mock of [sync.github, sync.gitea])
      mock.mockImplementation((id: string) =>
        db
          .select()
          .from(schema.labelTable)
          .where(eq(schema.labelTable.taskId, id)),
      );
    const response = await request("removeLabel", label!.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, updatedCount: 2 });
    for (const mock of [sync.github, sync.gitea]) {
      expect(mock).toHaveBeenCalledTimes(2);
      for (const result of mock.mock.results)
        expect(await result.value).toEqual([]);
    }
    const after = await rows();
    for (const row of after)
      expect(row.version).toBe(
        tasks.find((task) => task.id === row.id)!.version + 1,
      );
    expect((await request("removeLabel", label!.id)).status).toBe(409);
    expect(sync.github).toHaveBeenCalledTimes(2);
    expect(await rows()).toEqual(after);
  });

  it("rejects stale label selection and foreign workspace label without side effects", async () => {
    const { member, tasks, request, rows } = await fixture();
    const foreign = await createWorkspaceMember({ role: "owner" });
    const [label] = await db
      .insert(schema.labelTable)
      .values({
        name: "Private",
        color: "blue",
        workspaceId: foreign.workspace.id,
      })
      .returning();
    expect((await request("removeLabel", label!.id)).status).toBe(400);
    expect((await request("addLabel", label!.id)).status).toBe(400);
    const [local] = await db
      .insert(schema.labelTable)
      .values({ name: "Bulk", color: "blue", workspaceId: member.workspace.id })
      .returning();
    await db
      .update(schema.taskTable)
      .set({ description: "Newer prose" })
      .where(eq(schema.taskTable.id, tasks[0]!.id));
    const before = await rows();
    expect((await request("addLabel", local!.id)).status).toBe(409);
    expect(await rows()).toEqual(before);
    expect(await db.select().from(schema.labelTable)).toHaveLength(2);
    expect(sync.github).not.toHaveBeenCalled();
    expect(sync.gitea).not.toHaveBeenCalled();
  });
});
