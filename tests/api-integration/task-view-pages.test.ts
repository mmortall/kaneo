import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

describe("Filtered summary views", () => {
  beforeEach(resetTestDatabase);
  async function fixture(count: number) {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
      slug: "view",
    });
    const statuses = ["to-do", "done", "archived", "planned", "blocked"];
    for (let offset = 0; offset < count; offset += 1000) {
      await db.insert(schema.taskTable).values(
        Array.from({ length: Math.min(1000, count - offset) }, (_, i) => {
          const index = offset + i;
          return {
            id: `view-${index}`,
            projectId: project.id,
            number: index + 1,
            title: `Task ${index}`,
            description:
              index === count - 1
                ? "Late DESCRIPTION needle %_"
                : "Long prose ".repeat(100),
            status: statuses[index % statuses.length],
            position: index,
            priority: index % 2 ? "high" : null,
            userId: index % 2 ? member.user.id : null,
            dueDate: index % 2 ? new Date("2026-10-12T00:00:00Z") : null,
          };
        }),
      );
    }
    mockAuthenticatedSession(member.user);
    return { app: createApp().app, project, member };
  }
  const tasks = (data: any) => [
    ...data.columns.flatMap((column: any) => column.tasks),
    ...data.archivedTasks,
    ...data.plannedTasks,
    ...data.blockedTasks,
  ];
  async function view(
    app: ReturnType<typeof createApp>["app"],
    projectId: string,
    body: object = {},
  ) {
    return app.request(`/api/task/agent/view/${projectId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it.each([4344, 20000])(
    "bounds initial payload and filters before paging at %i tasks",
    async (count) => {
      const { app, project } = await fixture(count);
      const first = await view(app, project.id);
      expect(first.status).toBe(200);
      const raw = await first.text();
      expect(raw.length).toBeLessThan(100_000);
      const body = JSON.parse(raw);
      expect(tasks(body.data)).toHaveLength(50);
      expect(
        tasks(body.data).every((task: any) => task.description === null),
      ).toBe(true);
      expect(body.pagination).toMatchObject({
        total: count,
        nextPage: 2,
        hasMore: true,
      });
      expect(
        Object.values(body.data.countsByStatus).reduce(
          (sum: number, n) => sum + Number(n),
          0,
        ),
      ).toBe(count);
      expect(body.data.columns.map((column: any) => column.id)).toContain(
        "done",
      );
      const found = await view(app, project.id, {
        filters: { text: " DESCRIPTION needle %_ " },
      });
      expect(found.status).toBe(200);
      const match = await found.json();
      expect(tasks(match.data).map((task: any) => task.id)).toEqual([
        `view-${count - 1}`,
      ]);
      expect(match.pagination).toMatchObject({
        total: 1,
        nextPage: null,
        hasMore: false,
      });
      const scheduled = await view(app, project.id, {
        filters: { scheduledOnly: true, excludeStatuses: ["archived"] },
        sortBy: "scheduleStart",
      });
      expect(scheduled.status).toBe(200);
      const scheduledRaw = await scheduled.text();
      expect(scheduledRaw.length).toBeLessThan(100_000);
      const scheduledBody = JSON.parse(scheduledRaw);
      expect(tasks(scheduledBody.data)).toHaveLength(50);
      expect(
        tasks(scheduledBody.data).every(
          (task: any) => task.dueDate && task.status !== "archived",
        ),
      ).toBe(true);
      expect(scheduledBody.pagination.total).toBe(
        Array.from({ length: count }, (_, i) => i).filter(
          (i) => i % 2 === 1 && i % 5 !== 2,
        ).length,
      );
      expect(scheduledBody.data.scheduleBounds).toEqual({
        start: "2026-10-12T00:00:00.000000Z",
        end: "2026-10-12T00:00:00.000000Z",
      });
      const last = await view(app, project.id, { page: Math.ceil(count / 50) });
      expect(
        tasks((await last.json()).data).map((task: any) => task.number),
      ).toContain(count);
    },
    60_000,
  );

  it("excludes virtual statuses before paging and counting active columns", async () => {
    const { app, project } = await fixture(305);
    const capabilities = await app.request("/api/task/agent/capabilities");
    expect((await capabilities.json()).taskViewExclusions).toBe(true);
    const ids: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const response = await view(app, project.id, {
        page,
        filters: { excludeStatuses: ["archived", "planned", "blocked"] },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.pagination).toMatchObject({ total: 122, totalPages: 3 });
      expect(body.data.countsByStatus).toEqual({ "to-do": 61, done: 61 });
      expect(body.data.archivedTasks).toEqual([]);
      expect(body.data.plannedTasks).toEqual([]);
      expect(body.data.blockedTasks).toEqual([]);
      ids.push(...tasks(body.data).map((task: any) => task.id));
    }
    expect(ids).toHaveLength(122);
    expect(new Set(ids).size).toBe(122);
    const archived = await view(app, project.id, {
      filters: { statuses: ["archived"], excludeStatuses: ["archived"] },
    });
    expect((await archived.json()).pagination.total).toBe(0);
  });

  it("filters and globally orders scheduled rows with complete normalized bounds", async () => {
    const { app, project } = await fixture(305);
    const { sql } = await import("drizzle-orm");
    await db.execute(
      sql`UPDATE task SET due_date = NULL, start_date = NULL WHERE project_id = ${project.id}`,
    );
    await db.execute(
      sql`UPDATE task SET start_date = '2026-10-12', due_date = '2026-10-10' WHERE id = 'view-300'`,
    );
    await db.execute(
      sql`UPDATE task SET start_date = '2026-10-11' WHERE id = 'view-303'`,
    );
    await db.execute(
      sql`UPDATE task SET due_date = '2026-10-15' WHERE id = 'view-304'`,
    );
    await db.execute(
      sql`UPDATE task SET due_date = '2020-01-01' WHERE id = 'view-302'`,
    );
    const capabilities = await app.request("/api/task/agent/capabilities");
    expect((await capabilities.json()).scheduledTaskViews).toBe(true);
    const filters = { scheduledOnly: true, excludeStatuses: ["archived"] };
    const result = await view(app, project.id, {
      filters,
      sortBy: "scheduleStart",
      limit: 1,
    });
    expect(result.status).toBe(200);
    const body = await result.json();
    expect(body.pagination).toMatchObject({
      total: 3,
      totalPages: 3,
      hasMore: true,
    });
    expect(tasks(body.data).map((task: any) => task.id)).toEqual(["view-300"]);
    expect(body.data.scheduleBounds).toEqual({
      start: "2026-10-10T00:00:00.000000Z",
      end: "2026-10-15T00:00:00.000000Z",
    });
    const second = await view(app, project.id, {
      filters,
      sortBy: "scheduleStart",
      limit: 1,
      page: 2,
    });
    const secondBody = await second.json();
    expect(tasks(secondBody.data).map((task: any) => task.id)).toEqual([
      "view-303",
    ]);
    expect(secondBody.data.scheduleBounds).toEqual(body.data.scheduleBounds);
    const blocked = await view(app, project.id, {
      filters: { ...filters, searchStatus: true, text: "BLOCKED" },
      sortBy: "scheduleStart",
    });
    expect(
      tasks((await blocked.json()).data).map((task: any) => task.id),
    ).toEqual(["view-304"]);
    const missing = await view(app, project.id, {
      filters: { ...filters, text: "missing-schedule-needle" },
    });
    const missingBody = await missing.json();
    expect(missingBody.pagination.total).toBe(0);
    expect(missingBody.data.scheduleBounds).toEqual({ start: null, end: null });
  });

  it("sparse Gantt date changes preserve prose and reject stale revisions", async () => {
    const { app } = await fixture(1);
    const before = await db.query.taskTable.findFirst({
      where: (table, { eq }) => eq(table.id, "view-0"),
    });
    const edit = (expectedVersion: number, dueDate: string) =>
      app.request("/api/task/agent/view-0", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion,
          startDate: "2026-10-10T00:00:00Z",
          dueDate,
        }),
      });
    expect((await edit(before!.version, "2026-10-12T00:00:00Z")).status).toBe(
      200,
    );
    const after = await db.query.taskTable.findFirst({
      where: (table, { eq }) => eq(table.id, "view-0"),
    });
    expect(after).toMatchObject({
      title: before!.title,
      description: before!.description,
      status: before!.status,
      priority: before!.priority,
      version: before!.version + 1,
      startDate: new Date("2026-10-10T00:00:00Z"),
      dueDate: new Date("2026-10-12T00:00:00Z"),
    });
    expect((await edit(before!.version, "2026-10-14T00:00:00Z")).status).toBe(
      409,
    );
    const latest = await db.query.taskTable.findFirst({
      where: (table, { eq }) => eq(table.id, "view-0"),
    });
    expect(latest).toEqual(after);
  });

  it("preserves combined multi-value filters and OR due-date selections", async () => {
    const { app, project, member } = await fixture(210);
    const allMatching: string[] = [];
    let page = 1;
    while (true) {
      const response = await view(app, project.id, {
        page,
        limit: 25,
        filters: { statuses: ["done", "blocked"] },
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.pagination.total).toBe(84);
      expect(body.data.countsByStatus).toEqual({ done: 42, blocked: 42 });
      allMatching.push(...tasks(body.data).map((task: any) => task.id));
      if (!body.pagination.hasMore) break;
      expect(body.pagination.nextPage).toBe(page + 1);
      page = body.pagination.nextPage;
    }
    expect(new Set(allMatching)).toEqual(
      new Set(
        Array.from({ length: 210 }, (_, i) => i)
          .filter((i) => [1, 4].includes(i % 5))
          .map((i) => `view-${i}`),
      ),
    );
    expect(allMatching).toHaveLength(84);
    const [label] = await db
      .insert(schema.labelTable)
      .values({
        taskId: "view-209",
        workspaceId: member.workspace.id,
        name: "Later",
        color: "#fff",
      })
      .returning();
    const extra = await db
      .insert(schema.labelTable)
      .values([
        {
          taskId: "view-0",
          workspaceId: member.workspace.id,
          name: "Later",
          color: "#fff",
        },
        {
          taskId: "view-209",
          workspaceId: member.workspace.id,
          name: "Other",
          color: "#fff",
        },
        {
          taskId: "view-1",
          workspaceId: member.workspace.id,
          name: "Later",
          color: "#000",
        },
      ])
      .returning();
    const grouped = await view(app, project.id, {
      filters: {
        labelGroups: [
          { name: "Later", color: "#fff" },
          { name: "Other", color: "#fff" },
        ],
      },
    });
    const groupBody = await grouped.json();
    expect(grouped.status).toBe(200);
    expect(groupBody.pagination.total).toBe(2);
    expect(
      tasks(groupBody.data)
        .map((task: any) => task.id)
        .sort(),
    ).toEqual(["view-0", "view-209"]);
    const union = await view(app, project.id, {
      filters: {
        labels: [extra[2].id],
        labelGroups: [{ name: "Later", color: "#fff" }],
      },
    });
    expect((await union.json()).pagination.total).toBe(3);
    const legacyLabels = await view(app, project.id, {
      filters: {
        labels: [
          label.id,
          ...Array.from({ length: 200 }, (_, i) => `old-selection-${i}`),
        ],
      },
    });
    expect((await legacyLabels.json()).pagination.total).toBe(1);
    const filtered = await view(app, project.id, {
      filters: {
        statuses: ["done", "blocked"],
        priorities: ["high"],
        assignees: [member.user.id],
        labels: [label.id],
        dueRanges: [
          { start: "2026-10-11T00:00:00Z", end: "2026-10-13T00:00:00Z" },
        ],
        noDueDate: true,
      },
    });
    expect(filtered.status).toBe(200);
    const body = await filtered.json();
    expect(tasks(body.data).map((task: any) => task.id)).toEqual(["view-209"]);
    expect(body.data.countsByStatus).toEqual({ blocked: 1 });
    for (const text of ["view-210", "#210"]) {
      const found = await view(app, project.id, { filters: { text } });
      expect(
        tasks((await found.json()).data).map((task: any) => task.id),
      ).toEqual(["view-209"]);
    }
    const unassigned = await view(app, project.id, {
      filters: { assignees: [""], priorities: [""], noDueDate: true },
    });
    const noDate = await unassigned.json();
    expect(noDate.pagination.total).toBe(105);
    expect(
      tasks(noDate.data).every(
        (task: any) =>
          task.userId === null &&
          task.priority === null &&
          task.dueDate === null,
      ),
    ).toBe(true);
  });

  it("rejects invalid bounds and unauthorized project access", async () => {
    const { app, project } = await fixture(0);
    for (const body of [
      { limit: 101 },
      { page: 0 },
      {
        filters: {
          dueRanges: [
            { start: "2026-10-13T00:00:00Z", end: "2026-10-11T00:00:00Z" },
          ],
        },
      },
    ]) {
      expect((await view(app, project.id, body)).status).toBe(400);
    }
    const outsider = await createWorkspaceMember();
    mockAuthenticatedSession(outsider.user);
    expect((await view(app, project.id)).status).toBe(403);
  });
});
