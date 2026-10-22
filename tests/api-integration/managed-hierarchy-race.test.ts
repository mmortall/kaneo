import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { getDatabasePool, schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import * as hierarchy from "../../apps/api/src/task-relation/work-item-hierarchy";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

describe("Managed hierarchy races", () => {
  beforeEach(resetTestDatabase);

  async function fixture() {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const items = ["epic", "sub_epic", "task"].map((workItemType, index) => ({
      key: `managed-race:${workItemType}`,
      title: `Managed race ${index}`,
      description: "Owned managed fixture",
      goal: "Keep hierarchy valid",
      acceptanceCriteria: "Stale type write conflicts",
      workItemType,
    }));
    const existing = await db
      .insert(schema.taskTable)
      .values(
        items.slice(0, 2).map((item, index) => ({
          ...item,
          workItemType: item.workItemType as "epic" | "sub_epic",
          id: `managed-race-${index}`,
          managedKey: item.key,
          projectId: project.id,
          number: index + 1,
        })),
      )
      .returning();
    await db
      .update(schema.projectTable)
      .set({ lastTaskNumber: 2 })
      .where(eq(schema.projectTable.id, project.id));
    await db.insert(schema.taskRelationTable).values({
      sourceTaskId: existing[0].id,
      targetTaskId: existing[1].id,
      relationType: "subtask",
    });
    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    return { app, items, existing, project };
  }

  it("preserves hierarchy when legacy validation races managed child insertion", async () => {
    const { app, items, existing, project } = await fixture();
    let validationReached!: () => void;
    let resumeWrite!: () => void;
    const reached = new Promise<void>((resolve) => {
      validationReached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resumeWrite = resolve;
    });
    const validate = hierarchy.assertWorkItemTypeChangeAllowed;
    vi.spyOn(hierarchy, "assertWorkItemTypeChangeAllowed").mockImplementation(
      async (...args) => {
        await validate(...args);
        validationReached();
        await gate;
      },
    );
    const parent = existing[1];
    const write = app.request(`/api/task/${parent.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: parent.title,
        description: parent.description,
        status: parent.status,
        priority: parent.priority,
        position: parent.position,
        projectId: parent.projectId,
        expectedVersion: parent.version,
        workItemType: "task",
      }),
    });
    let ensured: Response | undefined;
    let ensureRequest: Promise<Response> | undefined;
    try {
      await reached;
      ensureRequest = app
        .request(`/api/task/agent/managed/${project.id}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-kaneo-caller": "ai",
          },
          body: JSON.stringify({ items }),
        })
        .then((response) => {
          ensured = response;
          return response;
        });
      await vi.waitFor(
        async () => {
          const { rows } = await getDatabasePool().query(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%project%for update%') AS waiting",
          );
          expect(Boolean(ensured) || rows[0].waiting).toBe(true);
        },
        { timeout: 3000 },
      );
    } finally {
      resumeWrite();
    }
    const response = await write;
    await ensureRequest;
    expect([ensured?.status, response.status].sort()).toEqual([200, 409]);
    const [persisted] = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, parent.id));
    expect(persisted.workItemType).toBe(
      ensured?.status === 200 ? "sub_epic" : "task",
    );
    expect(persisted.version).toBeGreaterThan(parent.version);
    const relations = await db.select().from(schema.taskRelationTable);
    expect(relations).toHaveLength(ensured?.status === 200 ? 2 : 1);
  }, 15000);
  it("returns committed revisions and preserves them on reuse", async () => {
    const { app, items, project } = await fixture();
    const ensure = () =>
      app.request(`/api/task/agent/managed/${project.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items }),
      });
    const created = await ensure();
    expect(created.status).toBe(200);
    const body = await created.json();
    const persisted = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.projectId, project.id));
    const versions = new Map(persisted.map((task) => [task.id, task.version]));
    for (const task of body.tasks)
      expect(task.version).toBe(versions.get(task.id));
    const replay = await ensure();
    expect(replay.status).toBe(200);
    const replayBody = await replay.json();
    expect(
      replayBody.tasks.map((task: { version: number }) => task.version),
    ).toEqual(body.tasks.map((task: { version: number }) => task.version));
    expect(replayBody.actions).toEqual(["reuse", "reuse", "reuse"]);
  });

  it("database rejects second parent and managed ensure retains valid hierarchy", async () => {
    const { app, items, existing, project } = await fixture();
    await db.insert(schema.taskTable).values({
      id: "extra-root",
      projectId: project.id,
      title: "Extra root",
      workItemType: "epic",
      number: 3,
    });
    await db
      .update(schema.projectTable)
      .set({ lastTaskNumber: 3 })
      .where(eq(schema.projectTable.id, project.id));
    await expect(
      db.insert(schema.taskRelationTable).values({
        sourceTaskId: "extra-root",
        targetTaskId: existing[1].id,
        relationType: "subtask",
      }),
    ).rejects.toMatchObject({
      cause: {
        code: "23505",
        constraint: "task_relation_subtask_target_unique",
      },
    });
    const response = await app.request(
      `/api/task/agent/managed/${project.id}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items }),
      },
    );
    expect(response.status).toBe(200);
    const tasks = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.projectId, project.id));
    expect(tasks).toHaveLength(4);
    expect(await db.select().from(schema.taskRelationTable)).toHaveLength(2);
  });

  it("rejects managed child creation after parent type change commits", async () => {
    const { app, items, existing, project } = await fixture();
    const parent = existing[1];
    const response = await app.request(`/api/task/${parent.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: parent.title,
        description: parent.description,
        status: parent.status,
        priority: parent.priority,
        position: parent.position,
        projectId: parent.projectId,
        expectedVersion: parent.version,
        workItemType: "task",
      }),
    });
    expect(response.status).toBe(200);
    const ensure = await app.request(`/api/task/agent/managed/${project.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items }),
    });
    expect(ensure.status).toBe(409);
    expect(
      await db
        .select()
        .from(schema.taskTable)
        .where(eq(schema.taskTable.projectId, project.id)),
    ).toHaveLength(2);
    expect(await db.select().from(schema.taskRelationTable)).toHaveLength(1);
  });
});
