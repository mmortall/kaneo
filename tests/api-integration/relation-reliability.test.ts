import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { taskOperationTable } from "../../apps/api/src/database/schema";
import * as events from "../../apps/api/src/events";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

describe("Concurrent relation delivery", () => {
  beforeEach(resetTestDatabase);

  async function fixture() {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    await db.insert(schema.taskTable).values([
      {
        id: "relation-source",
        projectId: project.id,
        number: 1,
        title: "Source",
        workItemType: "epic",
      },
      {
        id: "relation-target",
        projectId: project.id,
        number: 2,
        title: "Target",
        workItemType: "task",
      },
      {
        id: "relation-other",
        projectId: project.id,
        number: 3,
        title: "Other",
        workItemType: "epic",
      },
    ]);
    mockAuthenticatedSession(member.user);
    return createApp().app;
  }

  it("returns one committed relation and publishes once for sixteen keyed calls", async () => {
    const app = await fixture();
    const publish = vi.spyOn(events, "publishEvent");
    try {
      const responses = await Promise.all(
        Array.from({ length: 16 }, (_, index) =>
          app.request("/api/task-relation", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "Idempotency-Key": `relation-${index}`,
            },
            body: JSON.stringify({
              sourceTaskId: index % 2 ? "relation-source" : "relation-target",
              targetTaskId: index % 2 ? "relation-target" : "relation-source",
              relationType: "related",
            }),
          }),
        ),
      );
      expect(responses.map((response) => response.status)).toEqual(
        Array(16).fill(200),
      );
      const bodies = await Promise.all(
        responses.map((response) => response.json()),
      );
      expect(new Set(bodies.map((body) => body.id)).size).toBe(1);
      expect(await db.select().from(schema.taskRelationTable)).toHaveLength(1);
      expect(
        publish.mock.calls.filter(
          (call) => call[0] === "task-relation.created",
        ),
      ).toHaveLength(1);
    } finally {
      publish.mockRestore();
    }
  });
  it("returns task revisions and rejects edits using a stale relation snapshot", async () => {
    const app = await fixture();
    const created = await app.request("/api/task-relation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceTaskId: "relation-source",
        targetTaskId: "relation-target",
        relationType: "related",
      }),
    });
    expect(created.status).toBe(200);
    const response = await app.request("/api/task-relation/relation-source");
    expect(response.status).toBe(200);
    const [relation] = await response.json();
    const stored = await db
      .select({ id: schema.taskTable.id, version: schema.taskTable.version })
      .from(schema.taskTable);
    for (const snapshot of [relation.sourceTask, relation.targetTask]) {
      expect(snapshot.version).toBe(
        stored.find((task) => task.id === snapshot.id)?.version,
      );
      expect(Number.isSafeInteger(snapshot.version)).toBe(true);
    }
    const target =
      relation.sourceTask.id === "relation-target"
        ? relation.sourceTask
        : relation.targetTask;
    const patch = (fields: object) =>
      app.request("/api/task/agent/relation-target", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: target.version, ...fields }),
      });
    expect((await patch({ title: "Newer target title" })).status).toBe(200);
    expect((await patch({ status: "planned" })).status).toBe(409);
    const latest = await app.request("/api/task/relation-target");
    expect(await latest.json()).toMatchObject({
      title: "Newer target title",
      version: target.version + 1,
    });
  });

  it("replays same operation but rejects changed payload and preserves legacy conflict", async () => {
    const app = await fixture();
    const post = (targetTaskId: string, key?: string) =>
      app.request("/api/task-relation", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        body: JSON.stringify({
          sourceTaskId: "relation-source",
          targetTaskId,
          relationType: "related",
        }),
      });
    const first = await post("relation-target", "durable-relation");
    expect(first.status).toBe(200);
    const replay = await post("relation-target", "durable-relation");
    expect(replay.status).toBe(200);
    expect((await replay.json()).id).toBe((await first.json()).id);
    expect((await post("relation-other", "durable-relation")).status).toBe(409);
    expect((await post("relation-target")).status).toBe(409);
    expect(await db.select().from(schema.taskRelationTable)).toHaveLength(1);
  });

  it("serializes competing hierarchy parents and never returns database error", async () => {
    const app = await fixture();
    const responses = await Promise.all(
      ["relation-source", "relation-other"].map((sourceTaskId) =>
        app.request("/api/task-relation", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": sourceTaskId,
          },
          body: JSON.stringify({
            sourceTaskId,
            targetTaskId: "relation-target",
            relationType: "subtask",
          }),
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(await db.select().from(schema.taskRelationTable)).toHaveLength(1);
    expect(
      await db
        .select()
        .from(schema.taskTable)
        .where(eq(schema.taskTable.id, "relation-target")),
    ).toHaveLength(1);
  });

  it("does not treat reversed hierarchy or blocking edge as successful replay", async () => {
    const app = await fixture();
    for (const relationType of ["subtask", "blocks"]) {
      const post = (sourceTaskId: string, targetTaskId: string) =>
        app.request("/api/task-relation", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": `${relationType}:${sourceTaskId}`,
          },
          body: JSON.stringify({ sourceTaskId, targetTaskId, relationType }),
        });
      expect((await post("relation-source", "relation-target")).status).toBe(
        200,
      );
      expect((await post("relation-target", "relation-source")).status).toBe(
        409,
      );
    }
    expect(await db.select().from(schema.taskRelationTable)).toHaveLength(2);
  });

  it("keeps hierarchy valid when relation creation races legacy type change", async () => {
    const app = await fixture();
    const [source] = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, "relation-source"));
    const responses = await Promise.all([
      app.request("/api/task-relation", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "type-race",
        },
        body: JSON.stringify({
          sourceTaskId: source.id,
          targetTaskId: "relation-target",
          relationType: "subtask",
        }),
      }),
      app.request(`/api/task/${source.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: source.title,
          description: "",
          priority: "medium",
          status: source.status,
          projectId: source.projectId,
          position: source.position,
          expectedVersion: source.version,
          workItemType: "task",
        }),
      }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const [persisted] = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, source.id));
    const relations = await db.select().from(schema.taskRelationTable);
    expect(relations.length === 0 || persisted.workItemType === "epic").toBe(
      true,
    );
  });

  it("scopes operation keys by mutation kind and retains target workspace boundary", async () => {
    const app = await fixture();
    const post = (targetTaskId: string) =>
      app.request("/api/task-relation", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "shared-key",
        },
        body: JSON.stringify({
          sourceTaskId: "relation-source",
          targetTaskId,
          relationType: "related",
        }),
      });
    expect((await post("relation-target")).status).toBe(200);
    const [source] = await db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.id, "relation-source"));
    const edit = await app.request(`/api/task/agent/${source.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "shared-key",
      },
      body: JSON.stringify({
        title: "Explicit edit",
        expectedVersion: source.version,
      }),
    });
    expect(edit.status).toBe(200);
    const other = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: other.workspace.id,
    });
    await db.insert(schema.taskTable).values({
      id: "foreign-target",
      projectId: project.id,
      number: 1,
      title: "Hidden",
    });
    expect((await post("foreign-target")).status).toBe(404);
    expect(await db.select().from(schema.taskRelationTable)).toHaveLength(1);
    expect(await db.select().from(taskOperationTable)).toHaveLength(2);
  });
});
