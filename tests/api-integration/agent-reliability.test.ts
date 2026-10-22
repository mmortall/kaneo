import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { getDatabasePool, schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAnonymousSession, mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

describe("Agent reliability", () => {
  beforeEach(resetTestDatabase);
  const headers = {
    "content-type": "application/json",
    "x-kaneo-caller": "ai",
  };

  it("ensures one hierarchy under sixteen concurrent starts and survives replay", async () => {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const items = ["epic", "sub_epic", "task"].map((kind, i) => ({
      key: `test:${kind}`,
      title: `Item ${i}`,
      description: "Managed test",
      goal: "Verify concurrent starts",
      acceptanceCriteria: "Exactly three items exist",
      workItemType: kind,
    }));
    const responses = await Promise.all(
      Array.from({ length: 16 }, () =>
        app.request(`/api/task/agent/managed/${project.id}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ items }),
        }),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual(Array(16).fill(200));
    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(new Set(bodies.map((b) => b.tasks[2].id)).size).toBe(1);
    const tasks = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.projectId, project.id));
    expect(tasks).toHaveLength(3);
    expect(await db.select().from(schema.taskRelationTable)).toHaveLength(2);
    expect(new Set(tasks.map((t) => t.number)).size).toBe(3);
    expect(bodies.filter((b) => b.actions.includes("create"))).toHaveLength(1);
  });

  it("adopts legacy titles without losing prose and supplies finish metadata", async () => {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    mockAuthenticatedSession(member.user);
    const items = ["epic", "sub_epic", "task"].map((kind, i) => ({
      key: `adopt:${kind}`,
      title: `Legacy ${i}`,
      description: `<!-- kaneo-managed:{"key":"adopt:${kind}"} -->`,
      goal: "Supplied goal",
      acceptanceCriteria: "Supplied criterion",
      workItemType: kind,
    }));
    for (const [i, item] of items.entries())
      await db.insert(schema.taskTable).values({
        id: `legacy-${i}`,
        projectId: project.id,
        number: i + 1,
        title: item.title,
        workItemType: item.workItemType as "epic" | "sub_epic" | "task",
        description: "Keep existing prose",
        status: "to-do",
        goal: i === 0 ? "Existing goal" : null,
      });
    const { app } = createApp();
    const response = await app.request(
      `/api/task/agent/managed/${project.id}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ items }),
      },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.actions).toEqual(["reuse", "reuse", "reuse"]);
    expect(body.tasks[0].goal).toBe("Existing goal");
    expect(body.tasks[2].goal).toBe("Supplied goal");
    expect(body.tasks[2].acceptanceCriteria).toBe("Supplied criterion");
    expect(body.tasks[2].description).toBe(
      `Keep existing prose\n\n${items[2].description}`,
    );
  });

  it("reads project identity without serializing its task collection", async () => {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    mockAuthenticatedSession(member.user);
    await db.insert(schema.taskTable).values({
      id: "summary-task",
      projectId: project.id,
      number: 1,
      title: "Large task",
      description: "x".repeat(10000),
    });
    const { app } = createApp();
    const summary = await app.request(
      `/api/project/${project.id}?summary=true`,
    );
    expect(summary.status).toBe(200);
    const value = await summary.json();
    expect(value.id).toBe(project.id);
    expect(value).not.toHaveProperty("tasks");
    const capability = await app.request("/api/task/agent/capabilities");
    expect(await capability.json()).toMatchObject({ projectSummaries: true });
    expect(
      (await app.request(`/api/project/${project.id}?summary=invalid`)).status,
    ).toBe(400);
    const full = await app.request(`/api/project/${project.id}`);
    expect((await full.json()).tasks).toHaveLength(1);
  });

  it("indexes legacy marker creation and rejects duplicate or conflicting identity", async () => {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const body = {
      projectId: project.id,
      title: "Legacy caller",
      status: "to-do",
      priority: "medium",
      goal: "Preserve identity",
      acceptanceCriteria: "One key",
      description: '<!-- kaneo-managed:{"key":"legacy:create"} -->',
    };
    const response = await app.request(`/api/task/${project.id}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    const task = await response.json();
    const persisted = await db.query.taskTable.findFirst({
      where: eq(schema.taskTable.id, task.id),
    });
    expect(persisted?.managedKey).toBe("legacy:create");
    const duplicate = await app.request(`/api/task/${project.id}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error).toBe("MANAGED_KEY_CONFLICT");
    await expect(
      db
        .update(schema.taskTable)
        .set({ description: '<!-- kaneo-managed:{"key":"other:key"} -->' })
        .where(eq(schema.taskTable.id, task.id)),
    ).rejects.toThrow();
    expect(
      (
        await db.query.taskTable.findFirst({
          where: eq(schema.taskTable.id, task.id),
        })
      )?.version,
    ).toBe(1);
  });

  it("rejects anonymous managed creation", async () => {
    mockAnonymousSession();
    const { app } = createApp();
    expect(
      (
        await app.request("/api/task/agent/managed/no-project", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
    ).toBe(401);
  });

  it("correlates real pool acquisition delay with request metrics", async () => {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const previous = process.env.KANEO_PERFORMANCE_LOG;
    process.env.KANEO_PERFORMANCE_LOG = "true";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const leases = await Promise.all(
      Array.from({ length: 10 }, () => getDatabasePool().connect()),
    );
    const release = () => {
      for (const lease of leases.splice(0)) lease.release();
    };
    const timer = setTimeout(release, 100);
    try {
      const response = await app.request(
        `/api/project/${project.id}?summary=true`,
        { headers: { "X-Request-Id": "pool-observation-test" } },
      );
      expect(response.status).toBe(200);
      const entry = log.mock.calls
        .flat()
        .filter((x) => typeof x === "string")
        .map((x) => {
          try {
            return JSON.parse(x);
          } catch {
            return null;
          }
        })
        .find((x) => x?.requestId === "pool-observation-test");
      expect(entry.queries).toBeGreaterThan(0);
      expect(entry.databaseAcquireMs).toBeGreaterThanOrEqual(40);
      const diagnostics = await app.request("/api/diagnostics");
      const value = await diagnostics.json();
      expect(value.cpuUserMs).toBeGreaterThan(0);
      expect(value.events.activeHandlers).toBeGreaterThanOrEqual(0);
    } finally {
      clearTimeout(timer);
      release();
      log.mockRestore();
      if (previous === undefined) delete process.env.KANEO_PERFORMANCE_LOG;
      else process.env.KANEO_PERFORMANCE_LOG = previous;
    }
  });

  it("detects conflicting writes and increments revision for legacy field updates", async () => {
    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Original",
        description: "Keep description",
        goal: "Goal",
        acceptanceCriteria: "Tests pass",
        status: "to-do",
        columnId: columns.todo.id,
      })
      .returning();
    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const results = await Promise.all(
      ["First", "Second"].map((title) =>
        app.request(`/api/task/agent/${task!.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ expectedVersion: task!.version, title }),
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const [current] = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task!.id));
    expect(current!.description).toBe("Keep description");
    expect(current!.version).toBe(task!.version + 1);
    await db
      .update(schema.taskTable)
      .set({ priority: "high" })
      .where(eq(schema.taskTable.id, task!.id));
    const [next] = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, task!.id));
    expect(next!.version).toBe(current!.version + 1);
  });

  it("bounds summaries and excludes long descriptions", async () => {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    await db.insert(schema.taskTable).values(
      Array.from({ length: 105 }, (_, i) => ({
        projectId: project.id,
        title: `Task ${i}`,
        number: i + 1,
        description: "x".repeat(10000),
        status: "planned",
      })),
    );
    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const response = await app.request(
      `/api/task/agent/summary/${project.id}?includeTotal=true`,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pagination).toMatchObject({
      pageSize: 50,
      total: 105,
      totalPages: 3,
    });
    expect(body.data.plannedTasks).toHaveLength(50);
    expect(
      body.data.plannedTasks.every(
        (t: { description: unknown }) => t.description === null,
      ),
    ).toBe(true);
    expect(
      (await app.request(`/api/task/agent/summary/${project.id}?limit=1000`))
        .status,
    ).toBe(400);
  });

  it("commits sixteen independent writes without exhausting transaction pool", async () => {
    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const tasks = await db
      .insert(schema.taskTable)
      .values(
        Array.from({ length: 16 }, (_, i) => ({
          projectId: project.id,
          title: `Task ${i}`,
          number: i + 1,
          goal: "Goal",
          acceptanceCriteria: "Pass",
          status: "to-do",
          columnId: columns.todo.id,
        })),
      )
      .returning();
    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const results = await Promise.all(
      tasks.map((t) =>
        app.request(`/api/task/agent/${t.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            expectedVersion: t.version,
            priority: "high",
          }),
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(16).fill(200));
  });

  it("serializes concurrent bulk policy checks and advances every affected revision", async () => {
    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const tasks = await db
      .insert(schema.taskTable)
      .values(
        Array.from({ length: 2 }, (_, i) => ({
          projectId: project.id,
          number: i + 1,
          title: `Bulk ${i}`,
          goal: "Goal",
          acceptanceCriteria: "Pass",
          status: "to-do",
          columnId: columns.todo.id,
        })),
      )
      .returning();
    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const responses = await Promise.all(
      Array.from({ length: 16 }, () =>
        app.request("/api/task/bulk", {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            taskIds: tasks.map((t) => t.id),
            operation: "updatePriority",
            value: "high",
          }),
        }),
      ),
    );
    expect(responses.every((r) => r.ok)).toBe(true);
    const updated = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.projectId, project.id));
    expect(
      updated.every((t) => t.version === 17 && t.priority === "high"),
    ).toBe(true);
  });

  it("rejects writes without revision and access to another workspace", async () => {
    const member = await createWorkspaceMember();
    const outsider = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Private",
        goal: "Goal",
        acceptanceCriteria: "Pass",
        status: "to-do",
        columnId: columns.todo.id,
      })
      .returning();
    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    expect(
      (
        await app.request(`/api/task/agent/${task!.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ title: "Invalid" }),
        })
      ).status,
    ).toBe(400);
    mockAuthenticatedSession(outsider.user);
    expect(
      (await app.request(`/api/task/agent/summary/${project.id}`)).status,
    ).toBe(403);
    expect(
      (
        await app.request(`/api/task/agent/${task!.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ expectedVersion: 1, title: "Forbidden" }),
        })
      ).status,
    ).toBe(403);
  });

  it.each([null, "Existing prose"])(
    "preserves omitted fields exactly when description is %s",
    async (description) => {
      const member = await createWorkspaceMember();
      const { project, columns } = await createProjectFixture({
        workspaceId: member.workspace.id,
      });
      const [before] = await db
        .insert(schema.taskTable)
        .values({
          projectId: project.id,
          title: "Original",
          description,
          priority: null,
          position: null,
          status: "to-do",
          columnId: columns.todo.id,
          goal: "Goal",
          acceptanceCriteria: "Pass",
          startDate: new Date("2026-01-01T00:00:00Z"),
          dueDate: new Date("2026-01-02T00:00:00Z"),
          userId: member.user.id,
          strategyHorizons: ["short"],
        })
        .returning();
      mockAuthenticatedSession(member.user);
      const { app } = createApp();
      const request = {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          expectedVersion: before!.version,
          title: "Renamed",
        }),
      };
      const response = await app.request(
        `/api/task/agent/${before!.id}`,
        request,
      );
      expect(response.status).toBe(200);
      const [after] = await db
        .select()
        .from(schema.taskTable)
        .where(eq(schema.taskTable.id, before!.id));
      expect(after).toEqual({
        ...before,
        title: "Renamed",
        version: before!.version + 1,
        updatedAt: after!.updatedAt,
      });
      expect(
        (await app.request(`/api/task/agent/${before!.id}`, request)).status,
      ).toBe(409);
      expect(
        await db
          .select()
          .from(schema.taskTable)
          .where(eq(schema.taskTable.id, before!.id)),
      ).toEqual([after]);
      const empty = await app.request(`/api/task/agent/${before!.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ expectedVersion: after!.version }),
      });
      expect(empty.status).toBe(400);
      expect(
        await db
          .select()
          .from(schema.taskTable)
          .where(eq(schema.taskTable.id, before!.id)),
      ).toEqual([after]);
    },
  );

  it("replays committed edits and comments without repeating mutation", async () => {
    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Original",
        goal: "Goal",
        acceptanceCriteria: "Pass",
        status: "to-do",
        columnId: columns.todo.id,
      })
      .returning();
    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const keyed = { ...headers, "Idempotency-Key": "test-operation" };
    const edit = {
      method: "PATCH",
      headers: keyed,
      body: JSON.stringify({
        expectedVersion: task!.version,
        title: "Updated",
      }),
    };
    const first = await app.request(`/api/task/agent/${task!.id}`, edit);
    expect(first.status).toBe(200);
    const replay = await app.request(`/api/task/agent/${task!.id}`, edit);
    expect(await replay.json()).toEqual(await first.json());
    expect(
      (
        await app.request(`/api/task/agent/${task!.id}`, {
          ...edit,
          body: JSON.stringify({
            expectedVersion: task!.version,
            title: "Different",
          }),
        })
      ).status,
    ).toBe(409);
    const comments = await Promise.all(
      Array.from({ length: 16 }, () =>
        app.request(`/api/comment/${task!.id}`, {
          method: "POST",
          headers: keyed,
          body: JSON.stringify({ content: "One completion" }),
        }),
      ),
    );
    expect(comments.every((r) => r.ok)).toBe(true);
    expect(
      new Set(
        (await Promise.all(comments.map((r) => r.json()))).map((c) => c.id),
      ).size,
    ).toBe(1);
    expect(
      await db
        .select()
        .from(schema.activityTable)
        .where(eq(schema.activityTable.taskId, task!.id)),
    ).toHaveLength(1);
  });
});
