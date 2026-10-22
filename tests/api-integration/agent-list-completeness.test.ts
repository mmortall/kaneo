import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { getDatabase, schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

describe("Agent list completeness and relation authorization", () => {
  beforeEach(resetTestDatabase);

  async function fixture() {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    await db.insert(schema.columnTable).values({
      projectId: project.id,
      name: "Paused",
      slug: "paused",
      position: 10,
    });
    const statuses = [
      "to-do",
      "in-progress",
      "done",
      "archived",
      "planned",
      "blocked",
      "paused",
    ];
    const types = ["task", "epic", "sub_epic"] as const;
    const categories = [
      "live_implementation",
      "research",
      "agent_blocker",
    ] as const;
    const tasks = Array.from({ length: 210 }, (_, index) => ({
      id: `list-${String(index).padStart(4, "0")}`,
      projectId: project.id,
      number: index + 1,
      title: "Same title",
      status: statuses[index % statuses.length]!,
      workItemType: types[Math.floor(index / 7) % types.length]!,
      taskCategory: categories[Math.floor(index / 14) % categories.length]!,
      userId: Math.floor(index / 42) % 2 ? member.user.id : null,
      priority: Math.floor(index / 21) % 2 ? "urgent" : "low",
      goal: index % 5 ? "Goal " + "g".repeat(1000) : "",
      acceptanceCriteria: index % 7 ? "Criterion " + "a".repeat(1000) : "",
      description: "d".repeat(1000),
      completionSummary: "c".repeat(1000),
      dueDate: new Date(Date.UTC(2026, 0, (index % 28) + 1)),
    }));
    await db.insert(schema.taskTable).values(tasks);
    mockAuthenticatedSession(member.user);
    return { member, project, tasks, app: createApp().app };
  }

  async function pages(
    app: ReturnType<typeof createApp>["app"],
    projectId: string,
    parameters: Record<string, string>,
  ) {
    const found: string[] = [];
    let pages = 1;
    let total = 0;
    for (let page = 1; page <= pages; page++) {
      const query = new URLSearchParams({
        ...parameters,
        limit: "17",
        page: String(page),
        sortBy: "title",
        includeTotal: "true",
      });
      const response = await app.request(
        `/api/task/agent/summary/${projectId}?${query}`,
      );
      expect(response.status).toBe(200);
      const value = await response.json();
      pages = value.pagination.totalPages;
      total = value.pagination.total;
      const tasks = [
        ...value.data.columns.flatMap(
          (column: { tasks: unknown[] }) => column.tasks,
        ),
        ...value.data.archivedTasks,
        ...value.data.plannedTasks,
        ...value.data.blockedTasks,
      ];
      expect(tasks.length).toBeLessThanOrEqual(17);
      for (const task of tasks) {
        expect(task.description).toBeNull();
        expect(task.goal).toBeNull();
        expect(task.acceptanceCriteria).toBeNull();
        expect(task.completionSummary).toBeNull();
        found.push(task.id);
      }
    }
    expect(new Set(found).size).toBe(found.length);
    expect(found.length).toBe(total);
    return found;
  }

  it("returns complete pages across every column and archived/planned/blocked sets with stable ties", async () => {
    const { app, project, tasks } = await fixture();
    const ids = await pages(app, project.id, {});
    // Containers group by status, so compare page membership rather than container order.
    expect([...ids].sort()).toEqual(tasks.map((task) => task.id));
    expect(await pages(app, project.id, {})).toEqual(ids);
  });

  it.each([undefined, "false", "true"])(
    "paginates with includeTotal=%s and counts only on request",
    async (includeTotal) => {
      const { app, project, tasks } = await fixture();
      const select = vi.spyOn(getDatabase(), "select");
      try {
        const found: string[] = [];
        let page: number | null = 1;
        while (page !== null) {
          const query = new URLSearchParams({
            limit: "30",
            page: String(page),
            sortBy: "number",
          });
          if (includeTotal !== undefined)
            query.set("includeTotal", includeTotal);
          const response = await app.request(
            `/api/task/agent/summary/${project.id}?${query}`,
          );
          expect(response.status).toBe(200);
          const value = await response.json();
          const selected = [
            ...value.data.columns.flatMap(
              (column: { tasks: { id: string }[] }) => column.tasks,
            ),
            ...value.data.archivedTasks,
            ...value.data.plannedTasks,
            ...value.data.blockedTasks,
          ];
          expect(selected).toHaveLength(30);
          found.push(...selected.map((task: { id: string }) => task.id));
          expect(value.pagination.total).toBe(
            includeTotal === "true" ? 210 : null,
          );
          expect(value.pagination.totalPages).toBe(
            includeTotal === "true" ? 7 : null,
          );
          expect(value.pagination.hasMore).toBe(page < 7);
          expect(value.pagination.nextPage).toBe(page < 7 ? page + 1 : null);
          page = value.pagination.nextPage;
        }
        expect([...found].sort()).toEqual(tasks.map((task) => task.id));
        expect(new Set(found).size).toBe(210);
        const countCalls = select.mock.calls.filter(
          ([selection]) => selection && "count" in selection,
        );
        expect(countCalls).toHaveLength(includeTotal === "true" ? 7 : 0);
      } finally {
        select.mockRestore();
      }
    },
  );

  it("returns terminal empty filtered pages and rejects invalid count switches", async () => {
    const { app, project } = await fixture();
    for (const query of ["status=missing", "status=blocked&limit=30&page=2"]) {
      const response = await app.request(
        `/api/task/agent/summary/${project.id}?${query}`,
      );
      expect(response.status).toBe(200);
      expect((await response.json()).pagination).toMatchObject({
        total: null,
        totalPages: null,
        hasMore: false,
        nextPage: null,
      });
    }
    expect(
      (
        await app.request(
          `/api/task/agent/summary/${project.id}?includeTotal=invalid`,
        )
      ).status,
    ).toBe(400);
  });

  it("preserves legacy counted lists and partial final summary pages", async () => {
    const { app, project, tasks } = await fixture();
    const legacy = await app.request(
      `/api/task/tasks/${project.id}?limit=17&page=2`,
    );
    expect(legacy.status).toBe(200);
    expect((await legacy.json()).pagination).toMatchObject({
      total: 210,
      totalPages: 13,
      page: 2,
      pageSize: 17,
    });
    const found: string[] = [];
    for (const page of [1, 2]) {
      const response = await app.request(
        `/api/task/agent/summary/${project.id}?status=blocked&limit=17&page=${page}`,
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.blockedTasks).toHaveLength(page === 1 ? 17 : 13);
      expect(body.pagination).toMatchObject({
        total: null,
        totalPages: null,
        hasMore: page === 1,
        nextPage: page === 1 ? 2 : null,
      });
      found.push(
        ...body.data.blockedTasks.map((task: { id: string }) => task.id),
      );
    }
    expect([...found].sort()).toEqual(
      tasks.filter((task) => task.status === "blocked").map((task) => task.id),
    );
  });

  it("enriches only selected page and retains ordered empty columns", async () => {
    const { app, project, tasks, member } = await fixture();
    const [integration] = await db
      .insert(schema.integrationTable)
      .values({
        projectId: project.id,
        type: "github",
        config: "{}",
      })
      .returning();
    for (const index of [0, 100]) {
      await db.insert(schema.labelTable).values({
        taskId: tasks[index]!.id,
        workspaceId: member.workspace.id,
        name: `Label ${index}`,
        color: "#123456",
      });
      await db.insert(schema.externalLinkTable).values({
        taskId: tasks[index]!.id,
        integrationId: integration!.id,
        resourceType: "issue",
        externalId: String(index),
        url: `https://example.com/issues/${index}`,
        metadata: '{"source":"fixture"}',
      });
    }
    const response = await app.request(
      `/api/task/agent/summary/${project.id}?limit=1&sortBy=number&includeTotal=true`,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pagination).toMatchObject({
      total: 210,
      pageSize: 1,
      totalPages: 210,
    });
    expect(
      body.data.columns.map((column: { slug: string }) => column.slug),
    ).toEqual(["to-do", "in-progress", "in-review", "done", "paused"]);
    const selected = body.data.columns.flatMap(
      (column: { tasks: unknown[] }) => column.tasks,
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      id: tasks[0]!.id,
      description: null,
      labels: [{ name: "Label 0", color: "#123456" }],
      externalLinks: [{ externalId: "0", metadata: { source: "fixture" } }],
    });
    expect(
      body.data.columns
        .slice(1)
        .every((column: { tasks: unknown[] }) => column.tasks.length === 0),
    ).toBe(true);
  });

  it.each([
    "status",
    "type",
    "assignee",
    "combined",
    "due",
    "ready",
    "category",
    "empty",
  ])("returns exact filtered set for %s", async (kind) => {
    const { app, project, member, tasks } = await fixture();
    let parameters: Record<string, string>;
    let expected = tasks;
    switch (kind) {
      case "status":
        parameters = { status: "archived" };
        expected = tasks.filter((task) => task.status === "archived");
        break;
      case "type":
        parameters = { workItemType: "epic" };
        expected = tasks.filter((task) => task.workItemType === "epic");
        break;
      case "assignee":
        parameters = { assigneeId: member.user.id };
        expected = tasks.filter((task) => task.userId === member.user.id);
        break;
      case "combined":
        parameters = {
          status: "blocked",
          workItemType: "sub_epic",
          priority: "urgent",
        };
        expected = tasks.filter(
          (task) =>
            task.status === "blocked" &&
            task.workItemType === "sub_epic" &&
            task.priority === "urgent",
        );
        break;
      case "due":
        parameters = {
          dueAfter: "2026-01-07T00:00:00Z",
          dueBefore: "2026-01-14T00:00:00Z",
        };
        expected = tasks.filter(
          (task) =>
            task.dueDate >= new Date(parameters.dueAfter!) &&
            task.dueDate <= new Date(parameters.dueBefore!),
        );
        break;
      case "ready":
        parameters = { agentReadyOnly: "true" };
        expected = tasks.filter(
          (task) => task.goal !== "" && task.acceptanceCriteria !== "",
        );
        break;
      case "category":
        parameters = { taskCategory: "research" };
        expected = tasks.filter((task) => task.taskCategory === "research");
        break;
      default:
        parameters = { status: "nonexistent-status" };
        expected = [];
    }
    const ids = await pages(app, project.id, parameters);
    expect([...ids].sort()).toEqual(expected.map((task) => task.id));
  });

  it("excludes foreign-workspace relation endpoints and metadata while retaining authorized cross-project context", async () => {
    const member = await createWorkspaceMember();
    const foreign = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const { project: sameWorkspace } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const { project: otherWorkspace } = await createProjectFixture({
      workspaceId: foreign.workspace.id,
    });
    await db.insert(schema.taskTable).values([
      { id: "context-leaf", projectId: project.id, title: "Leaf" },
      {
        id: "context-authorized",
        projectId: sameWorkspace.id,
        title: "Authorized",
      },
      {
        id: "context-foreign",
        projectId: otherWorkspace.id,
        title: "Foreign private title",
      },
    ]);
    // Simulate historical relation surviving a project move across workspaces.
    await db.insert(schema.taskRelationTable).values([
      {
        sourceTaskId: "context-leaf",
        targetTaskId: "context-authorized",
        relationType: "related",
      },
      {
        sourceTaskId: "context-leaf",
        targetTaskId: "context-foreign",
        relationType: "related",
      },
    ]);
    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const response = await app.request("/api/task-relation/context-leaf");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0].targetTask.id).toBe("context-authorized");
    expect(JSON.stringify(body)).not.toContain("context-foreign");
    expect(JSON.stringify(body)).not.toContain("Foreign private title");
    expect((await app.request("/api/task/context-foreign")).status).toBe(403);
    mockAuthenticatedSession(foreign.user);
    expect((await app.request("/api/task-relation/context-leaf")).status).toBe(
      403,
    );
  });

  it("bounds context prose and relation pages while preserving ancestors and authorized continuation", async () => {
    const member = await createWorkspaceMember();
    const foreign = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const { project: privateProject } = await createProjectFixture({
      workspaceId: foreign.workspace.id,
    });
    const text = "x".repeat(20000);
    await db.insert(schema.taskTable).values([
      ...["root", "parent", "leaf"].map((id, index) => ({
        id,
        number: index + 1,
        projectId: project.id,
        title: id,
        description: text,
        goal: text,
        acceptanceCriteria: text,
      })),
      ...Array.from({ length: 40 }, (_, index) => ({
        id: `linked-${index}`,
        number: index + 4,
        projectId: project.id,
        title: `Related ${index}`,
        description: text,
        goal: text,
        acceptanceCriteria: text,
      })),
      {
        id: "foreign-link",
        projectId: privateProject.id,
        title: "Private context title",
      },
    ]);
    await db.insert(schema.taskRelationTable).values([
      {
        sourceTaskId: "root",
        targetTaskId: "parent",
        relationType: "subtask",
      },
      {
        sourceTaskId: "parent",
        targetTaskId: "leaf",
        relationType: "subtask",
      },
      ...Array.from({ length: 40 }, (_, index) => ({
        sourceTaskId: "leaf",
        targetTaskId: `linked-${index}`,
        relationType: "related",
      })),
      {
        sourceTaskId: "leaf",
        targetTaskId: "foreign-link",
        relationType: "related",
      },
    ]);
    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const response = await app.request("/api/task/agent/context/leaf");
    expect(response.status).toBe(200);
    const context = await response.json();
    expect(context.relations).toHaveLength(25);
    expect(context.pagination).toEqual({
      page: 1,
      limit: 25,
      hasMore: true,
      nextPage: 2,
    });
    expect(context.ancestor_ids).toEqual(["parent", "root"]);
    expect(context.task.description).toHaveLength(4096);
    expect(context.truncation.fields.leaf).toEqual(
      expect.arrayContaining(["description", "goal", "acceptanceCriteria"]),
    );
    expect(context.linked_tasks.length).toBeLessThanOrEqual(27);
    expect(
      context.linked_tasks.every(
        (task: { goal: string; description?: string }) =>
          task.goal.length <= 512 && task.description === undefined,
      ),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThan(150000);
    expect(JSON.stringify(context)).not.toContain("foreign-link");
    expect(JSON.stringify(context)).not.toContain("Private context title");
    const relationIds: string[] = [];
    let next: number | null = 1;
    while (next !== null) {
      const page = await app.request(
        `/api/task/agent/context/leaf?limit=7&page=${next}`,
      );
      expect(page.status).toBe(200);
      const value = await page.json();
      relationIds.push(
        ...value.relations.map((relation: { id: string }) => relation.id),
      );
      expect(value.ancestor_ids).toEqual(["parent", "root"]);
      next = value.pagination.nextPage;
    }
    expect(relationIds).toHaveLength(41);
    expect(new Set(relationIds).size).toBe(41);
    expect(
      (await app.request("/api/task/agent/context/leaf?limit=101")).status,
    ).toBe(400);
    expect(
      (await app.request("/api/task/agent/context/foreign-link")).status,
    ).toBe(403);
  });

  it("rejects cyclic context without walking indefinitely", async () => {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    await db.insert(schema.taskTable).values(
      ["cycle-a", "cycle-b", "cycle-c"].map((id, index) => ({
        id,
        number: index + 1,
        projectId: project.id,
        title: id,
      })),
    );
    await db.insert(schema.taskRelationTable).values([
      {
        sourceTaskId: "cycle-a",
        targetTaskId: "cycle-b",
        relationType: "subtask",
      },
      {
        sourceTaskId: "cycle-b",
        targetTaskId: "cycle-c",
        relationType: "subtask",
      },
      {
        sourceTaskId: "cycle-c",
        targetTaskId: "cycle-a",
        relationType: "subtask",
      },
    ]);
    mockAuthenticatedSession(member.user);
    const response = await createApp().app.request(
      "/api/task/agent/context/cycle-a",
    );
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("cyclic");
  });

  it("permits exactly 32 ancestors and rejects deeper context", async () => {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    await db.insert(schema.taskTable).values(
      Array.from({ length: 34 }, (_, index) => ({
        id: `depth-${index}`,
        number: index + 1,
        projectId: project.id,
        title: `Depth ${index}`,
      })),
    );
    await db.insert(schema.taskRelationTable).values(
      Array.from({ length: 33 }, (_, index) => ({
        sourceTaskId: `depth-${index}`,
        targetTaskId: `depth-${index + 1}`,
        relationType: "subtask",
      })),
    );
    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const within = await app.request("/api/task/agent/context/depth-32");
    expect(within.status).toBe(200);
    expect((await within.json()).ancestor_ids).toHaveLength(32);
    const beyond = await app.request("/api/task/agent/context/depth-33");
    expect(beyond.status).toBe(409);
    expect(await beyond.text()).toContain("exceeds 32 ancestors");
  });
});
