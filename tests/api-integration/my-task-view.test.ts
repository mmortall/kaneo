import { beforeEach, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

beforeEach(resetTestDatabase);

it.each([4344, 20000])(
  "bounds workspace page with %i assigned tasks",
  async (size) => {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    for (let offset = 0; offset < size; offset += 1000) {
      await db.insert(schema.taskTable).values(
        Array.from({ length: Math.min(1000, size - offset) }, (_, i) => ({
          id: `assigned-${String(offset + i).padStart(6, "0")}`,
          projectId: project.id,
          number: offset + i + 1,
          userId: member.user.id,
          title: `Task ${offset + i}`,
          status: "to-do",
          description: "x".repeat(1000),
          goal: "g".repeat(1000),
        })),
      );
    }
    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const response = await app.request(
      `/api/task/agent/my-view/${member.workspace.id}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: "live_implementation" }),
      },
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(Buffer.byteLength(text)).toBeLessThan(100000);
    const body = JSON.parse(text);
    expect(body.pagination).toMatchObject({
      total: size,
      pageSize: 50,
      hasMore: true,
      nextPage: 2,
    });
    expect(body.counts).toMatchObject({
      allCategoriesTotal: size,
      projectCount: 1,
      todoByCategory: { live_implementation: size },
    });
    const tasks = body.projects.flatMap(
      (p: { columns: { tasks: object[] }[] }) =>
        p.columns.flatMap((c) => c.tasks),
    );
    expect(tasks).toHaveLength(50);
    expect(tasks[0]).toMatchObject({
      version: 1,
      description: null,
      goal: null,
    });
  },
  60000,
);

it("filters across projects before paging and preserves complete category counts", async () => {
  const member = await createWorkspaceMember();
  const projects = await Promise.all(
    ["A", "B"].map((name) =>
      createProjectFixture({ workspaceId: member.workspace.id, name }),
    ),
  );
  for (let i = 0; i < 120; i++)
    await db.insert(schema.taskTable).values({
      id: `filtered-${i}`,
      number: i + 1,
      projectId: projects[i % 2].project.id,
      userId: member.user.id,
      title: `Assigned ${i}`,
      taskCategory: i % 3 === 0 ? "research" : "live_implementation",
      strategyHorizons: [i % 4 === 0 ? "long_term" : "short"],
      status: i % 5 === 0 ? "blocked" : "to-do",
    });
  await db.insert(schema.taskTable).values([
    {
      id: "planned-hidden",
      number: 121,
      projectId: projects[0].project.id,
      userId: member.user.id,
      title: "Planned",
      status: "planned",
    },
    {
      id: "unassigned-hidden",
      number: 122,
      projectId: projects[0].project.id,
      title: "Other user",
    },
  ]);
  mockAuthenticatedSession(member.user);
  const { app } = createApp();
  const ids: string[] = [];
  for (let page = 1; page <= 2; page++) {
    const response = await app.request(
      `/api/task/agent/my-view/${member.workspace.id}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: "research",
          horizon: "long_term",
          page,
          limit: 6,
        }),
      },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.counts).toMatchObject({
      total: 10,
      allCategoriesTotal: 30,
      categoryAllHorizonsTotal: 40,
      projectCount: 2,
    });
    expect(body.counts.todoByCategory.research).toBe(8);
    ids.push(
      ...body.projects.flatMap(
        (p: {
          columns: { tasks: { id: string }[] }[];
          blockedTasks: { id: string }[];
        }) =>
          [...p.columns.flatMap((c) => c.tasks), ...p.blockedTasks].map(
            (t) => t.id,
          ),
      ),
    );
  }
  expect(ids.sort()).toEqual(
    Array.from({ length: 10 }, (_, i) => `filtered-${i * 12}`).sort(),
  );
});

it("rejects another workspace and invalid bounded requests", async () => {
  const member = await createWorkspaceMember();
  const other = await createWorkspaceMember();
  mockAuthenticatedSession(member.user);
  const { app } = createApp();
  const request = (workspace: string, body: object) =>
    app.request(`/api/task/agent/my-view/${workspace}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  expect(
    (await request(other.workspace.id, { category: "research" })).status,
  ).toBe(403);
  expect(
    (await request(member.workspace.id, { category: "research", limit: 101 }))
      .status,
  ).toBe(400);
  expect(
    (
      await request(member.workspace.id, {
        category: "research",
        horizon: "invalid",
      })
    ).status,
  ).toBe(400);
});
it("keeps database query count bounded when one page spans fifty projects", async () => {
  const member = await createWorkspaceMember();
  for (let i = 0; i < 50; i++) {
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    await db.insert(schema.taskTable).values({
      id: `project-task-${i}`,
      number: 1,
      projectId: project.id,
      userId: member.user.id,
      title: `Task ${i}`,
      status: "to-do",
    });
  }
  mockAuthenticatedSession(member.user);
  const { app } = createApp();
  const previous = process.env.KANEO_PERFORMANCE_LOG;
  process.env.KANEO_PERFORMANCE_LOG = "true";
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const response = await app.request(
      `/api/task/agent/my-view/${member.workspace.id}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": "workspace-page-profile",
        },
        body: JSON.stringify({ category: "live_implementation" }),
      },
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text);
    expect(body.projects).toHaveLength(50);
    expect(body.counts.projectCount).toBe(50);
    expect(Buffer.byteLength(text)).toBeLessThan(200000);
    const entry = log.mock.calls
      .flat()
      .filter((value) => typeof value === "string")
      .map((value) => {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      })
      .find((value) => value?.requestId === "workspace-page-profile");
    expect(entry.queries).toBeLessThanOrEqual(12);
    log.mockRestore();
    console.info(
      JSON.stringify({
        benchmark: "workspace-page-50-projects",
        queries: entry.queries,
        durationMs: entry.durationMs,
        bytes: Buffer.byteLength(text),
      }),
    );
  } finally {
    log.mockRestore();
    if (previous === undefined) delete process.env.KANEO_PERFORMANCE_LOG;
    else process.env.KANEO_PERFORMANCE_LOG = previous;
  }
}, 60000);
