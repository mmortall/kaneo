import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { eventBusSnapshot } from "../../apps/api/src/events";
import { createApp } from "../../apps/api/src/index";
import previewManagedTasks from "../../apps/api/src/task/controllers/preview-managed-tasks";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

describe("Read-only managed hierarchy preview", () => {
  async function drainEvents() {
    await vi.waitFor(() => expect(eventBusSnapshot().activeHandlers).toBe(0), {
      timeout: 3000,
      interval: 10,
    });
  }
  beforeEach(async () => {
    await drainEvents();
    await resetTestDatabase();
  });
  afterEach(drainEvents);
  async function fixture() {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const items = (["epic", "sub_epic", "task"] as const).map(
      (workItemType, i) => ({
        key: `preview:${workItemType}`,
        title: `Preview ${i}`,
        workItemType,
        description: "Full description",
        goal: "Preview safely",
        acceptanceCriteria: "No persistent change",
      }),
    );
    mockAuthenticatedSession(member.user);
    const app = createApp().app;
    const request = (preview = true, data = items) =>
      app.request(
        `/api/task/agent/managed/${project.id}${preview ? "/preview" : ""}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: data }),
        },
      );
    return { app, items, project, request };
  }
  async function snapshot() {
    await drainEvents();
    return {
      tasks: await db.select().from(schema.taskTable),
      projects: await db.select().from(schema.projectTable),
      relations: await db.select().from(schema.taskRelationTable),
      activity: await db.select().from(schema.activityTable),
    };
  }
  it("plans missing hierarchy without allocating IDs/numbers or persisting events", async () => {
    const { request } = await fixture();
    const before = await snapshot();
    const response = await request();
    expect(response.status).toBe(200);
    const plan = await response.json();
    expect(plan.applied).toBe(false);
    expect(plan.actions).toEqual(["create", "create", "create"]);
    expect(plan.tasks.every((t: { id?: string }) => t.id === undefined)).toBe(
      true,
    );
    expect(await snapshot()).toEqual(before);
    const ensured = await request(false);
    expect(ensured.status).toBe(200);
    const actual = await ensured.json();
    expect(actual.actions).toEqual(plan.actions);
    expect(actual.tasks.map((t: { title: string }) => t.title)).toEqual(
      plan.tasks.map((t: { title: string }) => t.title),
    );
  });
  it("reuses final leaf without reopening or advancing revisions", async () => {
    const { request } = await fixture();
    const actual = await (await request(false)).json();
    const leaf = actual.tasks[2];
    await db
      .update(schema.taskTable)
      .set({ status: "done", completionSummary: "Owned fixture complete" })
      .where(eq(schema.taskTable.id, leaf.id));
    const before = await snapshot();
    const plan = await (await request()).json();
    expect(plan.actions).toEqual(["reuse", "reuse", "reuse"]);
    expect(plan.tasks[2].id).toBe(leaf.id);
    expect(plan.tasks[2].status).toBe("done");
    expect(await snapshot()).toEqual(before);
  });
  it("previews title adoption without editing candidate or policy fields", async () => {
    const { request, project, items } = await fixture();
    await db.insert(schema.taskTable).values({
      id: "manual-preview",
      projectId: project.id,
      number: 1,
      title: items[2].title,
      description: "Human prose",
      workItemType: "task",
    });
    await db
      .update(schema.projectTable)
      .set({ lastTaskNumber: 1 })
      .where(eq(schema.projectTable.id, project.id));
    const before = await snapshot();
    const response = await request();
    expect(response.status).toBe(200);
    const plan = await response.json();
    expect(plan.actions).toEqual(["create", "create", "adopt_title"]);
    expect(plan.tasks[2].id).toBe("manual-preview");
    expect(await snapshot()).toEqual(before);
    const actual = await (await request(false)).json();
    expect(actual.tasks[2].id).toBe(plan.tasks[2].id);
    expect(actual.tasks[2].goal).toBe(plan.tasks[2].goal);
  });
  it("rejects hierarchy conflict exactly as ensure without committing missing parent", async () => {
    const { request, items } = await fixture();
    expect((await request(false)).status).toBe(200);
    const changed = items.map((item, i) =>
      i === 1
        ? { ...item, key: "preview:other-parent", title: "Other parent" }
        : item,
    );
    const before = await snapshot();
    expect((await request(true, changed)).status).toBe(409);
    expect((await request(false, changed)).status).toBe(409);
    expect(await snapshot()).toEqual(before);
  });
  it("rejects ambiguous manual titles without adopting arbitrary candidate", async () => {
    const { request, items, project } = await fixture();
    await db.insert(schema.taskTable).values(
      [0, 1].map((i) => ({
        id: `ambiguous-${i}`,
        number: i + 1,
        projectId: project.id,
        title: items[0].title,
        workItemType: "epic" as const,
      })),
    );
    const before = await snapshot();
    expect((await request()).status).toBe(409);
    expect((await request(false)).status).toBe(409);
    expect(await snapshot()).toEqual(before);
  });
  it("shares spec validation and denies foreign project", async () => {
    const { app, request, items } = await fixture();
    expect((await request(true, [items[2], items[1], items[0]])).status).toBe(
      400,
    );
    const other = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: other.workspace.id,
    });
    const denied = await app.request(
      `/api/task/agent/managed/${project.id}/preview`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items }),
      },
    );
    expect([403, 404]).toContain(denied.status);
  });
  it("rechecks workspace inside read transaction after middleware authorization", async () => {
    const { project, items } = await fixture();
    const before = await snapshot();
    await expect(
      previewManagedTasks(project.id, "changed-workspace", items),
    ).rejects.toMatchObject({ status: 404 });
    expect(await snapshot()).toEqual(before);
  });
});
