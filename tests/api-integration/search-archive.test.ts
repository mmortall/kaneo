import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import getTask from "../../apps/api/src/task/controllers/get-task";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

describe("Archive-scoped global search", () => {
  beforeEach(resetTestDatabase);
  async function fixture(count = 60) {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
      slug: "arch",
    });
    for (let offset = 0; offset < count; offset += 1000) {
      await db.insert(schema.taskTable).values(
        Array.from({ length: Math.min(1000, count - offset) }, (_, i) => ({
          id: `arch-${offset + i}`,
          projectId: project.id,
          number: offset + i + 1,
          title: "Archive search needle",
          description: "Matching needle prose",
          status: offset + i === 0 ? "done" : "archived",
          position: offset + i,
          createdAt: new Date(
            offset + i === 0 ? "2020-01-01T00:00:00Z" : "2026-01-01T00:00:00Z",
          ),
        })),
      );
    }
    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const search = (params: Record<string, string> = {}) =>
      app.request(
        `/api/search?${new URLSearchParams({ q: "needle", workspaceId: member.workspace.id, type: "tasks", ...params })}`,
      );
    return { member, project, app, search };
  }
  it.each([4344, 20000])(
    "filters archive before LIMIT with %i tasks",
    async (count) => {
      const { search } = await fixture(count);
      const response = await search({ limit: "1" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        taskArchive: "active",
        results: [{ id: "arch-0", status: "done" }],
      });
      const archive = await search({ taskArchive: "archived", limit: "50" });
      const body = await archive.json();
      expect(archive.status).toBe(200);
      expect(body.taskArchive).toBe("archived");
      expect(body.results).toHaveLength(50);
      expect(
        body.results.every((task: any) => task.status === "archived"),
      ).toBe(true);
      const all = await search({ taskArchive: "all", q: "arch-1" });
      expect((await all.json()).results[0].id).toBe("arch-0");
    },
    60000,
  );
  it("applies archive scope to exact short IDs and retains direct archived task access", async () => {
    const { search } = await fixture();
    expect((await (await search({ q: "arch-2" })).json()).results).toEqual([]);
    for (const taskArchive of ["archived", "all"]) {
      const result = await search({ q: "arch-2", taskArchive });
      expect((await result.json()).results[0]).toMatchObject({
        id: "arch-1",
        status: "archived",
      });
    }
    expect(await getTask("arch-1")).toMatchObject({
      id: "arch-1",
      status: "archived",
      description: "Matching needle prose",
    });
  });
  it("filters comments and event data with their parent task archive scope", async () => {
    const { search, member } = await fixture();
    await db.insert(schema.activityTable).values([
      {
        id: "active-comment",
        taskId: "arch-0",
        type: "comment",
        content: "needle comment",
        userId: member.user.id,
      },
      {
        id: "archive-comment",
        taskId: "arch-1",
        type: "comment",
        content: "needle comment",
        userId: member.user.id,
      },
      {
        id: "archive-event",
        taskId: "arch-1",
        type: "title_changed",
        eventData: { oldTitle: "needle", newTitle: "changed" },
        userId: member.user.id,
      },
    ]);
    expect(
      (await (await search({ type: "comments" })).json()).results.map(
        (row: any) => row.id,
      ),
    ).toEqual(["active-comment"]);
    expect(
      (
        await (
          await search({ type: "comments", taskArchive: "archived" })
        ).json()
      ).results.map((row: any) => row.id),
    ).toEqual(["archive-comment"]);
    const events = await search({
      type: "activities",
      taskArchive: "archived",
    });
    expect(
      new Set((await events.json()).results.map((row: any) => row.id)),
    ).toEqual(new Set(["archive-comment", "archive-event"]));
    const all = await search({ type: "all" });
    expect((await all.json()).results.map((row: any) => row.id).sort()).toEqual(
      ["active-comment", "arch-0"],
    );
  });
  it("rejects invalid archive mode and keeps workspace access enforced", async () => {
    const { search } = await fixture();
    expect((await search({ taskArchive: "yes" })).status).toBe(400);
    const outsider = await createWorkspaceMember();
    mockAuthenticatedSession(outsider.user);
    for (const taskArchive of ["active", "archived", "all"]) {
      expect((await search({ taskArchive })).status).toBe(403);
    }
  });
  it("ranks title and description matches across active projects before global LIMIT", async () => {
    const { search, member, project } = await fixture(3);
    const second = await createProjectFixture({
      workspaceId: member.workspace.id,
      slug: "second",
    });
    const archived = await createProjectFixture({
      workspaceId: member.workspace.id,
      slug: "old",
    });
    await db
      .update(schema.projectTable)
      .set({ archivedAt: new Date() })
      .where(eq(schema.projectTable.id, archived.project.id));
    await db.insert(schema.taskTable).values([
      {
        id: "second-title",
        projectId: second.project.id,
        number: 1,
        title: "needle title",
        status: "done",
        position: 0,
        createdAt: new Date("2024-01-01T00:00:00Z"),
      },
      {
        id: "second-description",
        projectId: second.project.id,
        number: 2,
        title: "Other title",
        description: "needle description",
        status: "done",
        position: 1,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: "old-title",
        projectId: archived.project.id,
        number: 1,
        title: "needle archived project",
        status: "done",
        position: 0,
        createdAt: new Date("2027-01-01T00:00:00Z"),
      },
    ]);
    const ids = async (params: Record<string, string> = {}) => {
      const response = await search(params);
      expect(response.status).toBe(200);
      return (await response.json()).results.map(
        (row: { id: string }) => row.id,
      );
    };
    expect(await ids({ limit: "2" })).toEqual(["second-title", "arch-0"]);
    expect(await ids({ limit: "50" })).toEqual([
      "second-title",
      "arch-0",
      "second-description",
    ]);
    expect(await ids({ projectId: second.project.id })).toEqual([
      "second-title",
      "second-description",
    ]);
    expect(await ids({ projectId: project.id })).toEqual(["arch-0"]);
    expect(await ids({ projectId: archived.project.id })).toEqual([]);
    expect(
      await ids({ projectId: archived.project.id, taskArchive: "archived" }),
    ).toEqual(["old-title"]);
    expect(
      await ids({ projectId: archived.project.id, taskArchive: "all" }),
    ).toEqual(["old-title"]);
    expect(await ids({ q: "absent-match" })).toEqual([]);
    expect(await ids({ q: "n", projectId: second.project.id })).toEqual([
      "second-title",
      "second-description",
    ]);
  });
  it("excludes archived project tasks, exact IDs, projects and activities until explicitly requested", async () => {
    const { search, project, app, member } = await fixture(3);
    await db.insert(schema.activityTable).values({
      id: "project-archive-comment",
      taskId: "arch-0",
      type: "comment",
      content: "needle comment",
      userId: member.user.id,
    });
    await db
      .update(schema.projectTable)
      .set({ archivedAt: new Date(), name: "needle project" })
      .where(eq(schema.projectTable.id, project.id));
    for (const type of ["tasks", "projects", "comments", "activities", "all"]) {
      const response = await search({ type });
      expect(response.status).toBe(200);
      expect((await response.json()).results).toEqual([]);
    }
    expect((await (await search({ q: "arch-1" })).json()).results).toEqual([]);
    for (const taskArchive of ["archived", "all"]) {
      const exact = await search({ q: "arch-1", taskArchive });
      expect((await exact.json()).results[0]).toMatchObject({
        id: "arch-0",
        status: "done",
      });
      const projects = await search({ type: "projects", taskArchive });
      expect((await projects.json()).results.map((row) => row.id)).toEqual([
        project.id,
      ]);
      const comments = await search({ type: "comments", taskArchive });
      expect((await comments.json()).results.map((row) => row.id)).toEqual([
        "project-archive-comment",
      ]);
    }
    expect((await app.request("/api/task/arch-0")).status).toBe(200);
    await db
      .update(schema.projectTable)
      .set({ archivedAt: null })
      .where(eq(schema.projectTable.id, project.id));
    expect(
      (await (await search()).json()).results.map((row) => row.id),
    ).toEqual(["arch-0"]);
  });
});
