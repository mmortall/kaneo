import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

describe("Bounded full task export", () => {
  beforeEach(resetTestDatabase);
  async function fixture(count = 210) {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const statuses = ["to-do", "done", "archived", "planned", "blocked"];
    if (count)
      await db.insert(schema.taskTable).values(
        Array.from({ length: count }, (_, index) => ({
          id: `export-${String(index).padStart(4, "0")}`,
          projectId: project.id,
          number: index + 1,
          position: 0,
          title: `Export task ${index}`,
          priority: null,
          status: statuses[index % statuses.length],
          description: "Full description".repeat(400),
          goal: "Export goal",
          acceptanceCriteria: "Keep all fields",
          completionSummary: "Completion",
          taskCategory: "research" as const,
          strategyHorizons: ["short" as const],
        })),
      );
    mockAuthenticatedSession(member.user);
    return { app: createApp().app, project, member };
  }
  it("exports complete stable pages with full fields and page-local labels", async () => {
    const { app, project, member } = await fixture();
    await db.insert(schema.labelTable).values([
      {
        name: "First label",
        color: "#ffffff",
        taskId: "export-0000",
        workspaceId: member.workspace.id,
      },
      {
        name: "Last label",
        color: "#000000",
        taskId: "export-0209",
        workspaceId: member.workspace.id,
      },
    ]);
    const exported: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;
    const sizes: number[] = [];
    do {
      const response = await app.request(
        `/api/task/agent/export/${project.id}?limit=100${cursor ? `&cursor=${cursor}` : ""}`,
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      sizes.push(body.tasks.length);
      exported.push(...body.tasks);
      cursor = body.pagination.nextCursor;
    } while (cursor);
    expect(sizes).toEqual([100, 100, 10]);
    expect(new Set(exported.map((task) => task.title)).size).toBe(210);
    expect(exported[0]).toMatchObject({
      id: "export-0000",
      version: 1,
      number: 1,
      projectId: project.id,
      workItemType: "task",
      priority: null,
      description: "Full description".repeat(400),
      goal: "Export goal",
      acceptanceCriteria: "Keep all fields",
      completionSummary: "Completion",
      taskCategory: "research",
      strategyHorizons: ["short"],
      labels: [{ name: "First label", color: "#ffffff" }],
    });
    expect(exported[209].labels).toEqual([
      { name: "Last label", color: "#000000" },
    ]);
    expect(new Set(exported.map((task) => task.status))).toEqual(
      new Set(["to-do", "done", "archived", "planned", "blocked"]),
    );
    expect(new Set(exported.map((task) => task.id)).size).toBe(210);
    const legacy = await app.request(`/api/task/export/${project.id}`);
    const legacyTasks = (await legacy.json()).tasks;
    expect(legacyTasks).toHaveLength(210);
    expect(legacyTasks[0].priority).toBe("low");
    expect(legacyTasks[0].id).toBeUndefined();
  });
  it("cursor remains usable when earlier task is deleted", async () => {
    const { app, project } = await fixture(5);
    const first = await (
      await app.request(`/api/task/agent/export/${project.id}?limit=2`)
    ).json();
    await db
      .delete(schema.taskTable)
      .where(eq(schema.taskTable.id, "export-0000"));
    const next = await (
      await app.request(
        `/api/task/agent/export/${project.id}?limit=2&cursor=${first.pagination.nextCursor}`,
      )
    ).json();
    expect(next.tasks.map((task: { title: string }) => task.title)).toEqual([
      "Export task 2",
      "Export task 3",
    ]);
  });
  it("returns terminal empty page and rejects invalid limits", async () => {
    const { app, project } = await fixture(0);
    const body = await (
      await app.request(`/api/task/agent/export/${project.id}`)
    ).json();
    expect(body).toMatchObject({
      tasks: [],
      pagination: { limit: 100, nextCursor: null },
    });
    for (const limit of ["0", "101", "abc", "1.5"]) {
      expect(
        (
          await app.request(
            `/api/task/agent/export/${project.id}?limit=${limit}`,
          )
        ).status,
      ).toBe(400);
    }
  });
  it("denies foreign workspace export", async () => {
    const { app } = await fixture(0);
    const outsider = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: outsider.workspace.id,
    });
    expect(
      (await app.request(`/api/task/agent/export/${project.id}`)).status,
    ).toBe(403);
  });
});
