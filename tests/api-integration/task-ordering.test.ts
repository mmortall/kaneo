import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { asc, eq } from "drizzle-orm";
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
async function fixture(size = 5) {
  const member = await createWorkspaceMember();
  const { project } = await createProjectFixture({
    workspaceId: member.workspace.id,
  });
  for (let offset = 0; offset < size; offset += 1000)
    await db.insert(schema.taskTable).values(
      Array.from({ length: Math.min(1000, size - offset) }, (_, i) => ({
        id: `ordered-${String(offset + i).padStart(5, "0")}`,
        projectId: project.id,
        number: offset + i + 1,
        title: `Title ${offset + i}`,
        description: `Prose ${offset + i}`,
        status: "to-do",
        position: offset + i,
        goal: "Goal",
        acceptanceCriteria: "Acceptance",
      })),
    );
  await db
    .update(schema.projectTable)
    .set({ lastTaskNumber: size })
    .where(eq(schema.projectTable.id, project.id));
  mockAuthenticatedSession(member.user);
  const { app } = createApp();
  const post = (id: string, fields: object, key = crypto.randomUUID()) =>
    app.request(`/api/task/agent/order/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({
        projectId: project.id,
        status: "to-do",
        expectedVersion: 1,
        ...fields,
      }),
    });
  const rows = () =>
    db
      .select()
      .from(schema.taskTable)
      .where(eq(schema.taskTable.projectId, project.id))
      .orderBy(asc(schema.taskTable.position), asc(schema.taskTable.id));
  return { app, project, member, post, rows };
}

it("orders before hidden neighbors and replays committed result without another write", async () => {
  const { post, rows } = await fixture(150);
  const order = {
    anchor: { id: "ordered-00100", expectedVersion: 1, placement: "before" },
  };
  const response = await post("ordered-00000", order, "reorder-replay");
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result).toMatchObject({
    id: "ordered-00000",
    position: 99,
    version: 2,
  });
  expect(result).not.toHaveProperty("description");
  const updated = await rows();
  expect(updated[98].id).toBe("ordered-00099");
  expect(updated[99].id).toBe("ordered-00000");
  expect(updated[100].id).toBe("ordered-00100");
  expect(
    updated.every(
      (task) => task.description === `Prose ${Number(task.id.slice(-5))}`,
    ),
  ).toBe(true);
  const replay = await post("ordered-00000", order, "reorder-replay");
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(result);
  expect(await rows()).toEqual(updated);
  expect(
    (
      await post(
        "ordered-00000",
        { ...order, status: "planned" },
        "reorder-replay",
      )
    ).status,
  ).toBe(409);
});

it("moves to end of complete virtual status and retains other task fields", async () => {
  const { post, rows } = await fixture();
  await db
    .update(schema.taskTable)
    .set({ status: "planned", position: 20 })
    .where(eq(schema.taskTable.id, "ordered-00004"));
  const response = await post("ordered-00000", { status: "planned" });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    position: 21,
    status: "planned",
    version: 2,
  });
  const moved = (await rows()).find((task) => task.id === "ordered-00000")!;
  expect(moved).toMatchObject({
    title: "Title 0",
    description: "Prose 0",
    goal: "Goal",
    acceptanceCriteria: "Acceptance",
    columnId: null,
  });
});

it("rejects stale current or anchor revisions before changing neighbors", async () => {
  const { post, rows } = await fixture();
  await db
    .update(schema.taskTable)
    .set({ title: "Newer anchor title" })
    .where(eq(schema.taskTable.id, "ordered-00003"));
  const before = await rows();
  expect(
    (
      await post("ordered-00000", {
        anchor: { id: "ordered-00003", expectedVersion: 1, placement: "after" },
      })
    ).status,
  ).toBe(409);
  expect((await post("ordered-00003", {})).status).toBe(409);
  expect(await rows()).toEqual(before);
});

it("serializes sixteen stale-snapshot contenders without lost prose or server errors", async () => {
  const { post, rows } = await fixture(17);
  const responses = await Promise.all(
    Array.from({ length: 16 }, () =>
      post("ordered-00000", {
        anchor: { id: "ordered-00016", expectedVersion: 1, placement: "after" },
      }),
    ),
  );
  expect(
    responses
      .map((response) => response.status)
      .every((status) => status === 200 || status === 409),
  ).toBe(true);
  expect(responses.filter((response) => response.status === 200)).toHaveLength(
    1,
  );
  const after = await rows();
  expect(new Set(after.map((task) => task.position)).size).toBe(17);
  expect(
    after.every(
      (task) => task.description === `Prose ${Number(task.id.slice(-5))}`,
    ),
  ).toBe(true);
});

it("rolls back ordering when agent workflow policy rejects transition", async () => {
  const { app, project, rows } = await fixture();
  const before = await rows();
  const response = await app.request("/api/task/agent/order/ordered-00000", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": "policy-test",
      "x-kaneo-caller": "ai",
    },
    body: JSON.stringify({
      projectId: project.id,
      status: "done",
      expectedVersion: 1,
    }),
  });
  expect(response.status).toBe(409);
  expect(await rows()).toEqual(before);
});

it("bounds reorder response over twenty thousand tasks", async () => {
  const { app, project, rows } = await fixture(20000);
  const previous = process.env.KANEO_PERFORMANCE_LOG;
  process.env.KANEO_PERFORMANCE_LOG = "true";
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const body = JSON.stringify({
      projectId: project.id,
      status: "to-do",
      expectedVersion: 1,
      anchor: { id: "ordered-19999", expectedVersion: 1, placement: "after" },
    });
    const request = (requestId: string) =>
      app.request("/api/task/agent/order/ordered-00000", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": requestId,
          "X-Request-Id": requestId,
        },
        body,
      });
    const response = await request("order-profile-20k");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text.length).toBeLessThan(1000);
    expect(JSON.parse(text)).toMatchObject({ position: 20000, version: 2 });
    const after = await rows();
    expect(after.at(-1)?.id).toBe("ordered-00000");
    expect(new Set(after.map((task) => task.id)).size).toBe(20000);
    expect(after.slice(0, -1).every((task) => task.version === 1)).toBe(true);
    expect((await request("order-profile-stale-20k")).status).toBe(409);
    const entries = log.mock.calls
      .flat()
      .filter((value) => typeof value === "string")
      .map((value) => {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      })
      .filter(
        (value) =>
          value?.requestId === "order-profile-20k" ||
          value?.requestId === "order-profile-stale-20k",
      );
    expect(entries).toHaveLength(2);
    writeFileSync(
      new URL(
        "../../.cache/reliability-release/task-ordering-profile-20261008.json",
        import.meta.url,
      ),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          fixtureTasks: 20000,
          responseBytes: Buffer.byteLength(text),
          entries,
          controllerSha256: createHash("sha256")
            .update(
              readFileSync(
                new URL(
                  "../../apps/api/src/task/controllers/order-task.ts",
                  import.meta.url,
                ),
              ),
            )
            .digest("hex"),
          scope:
            "Two isolated in-process HTTP requests against real local PostgreSQL; no p95 or sustained-load claim",
        },
        null,
        2,
      ),
    );
  } finally {
    log.mockRestore();
    if (previous === undefined) delete process.env.KANEO_PERFORMANCE_LOG;
    else process.env.KANEO_PERFORMANCE_LOG = previous;
  }
}, 60000);
it("preserves exact null description and priority rather than replacing them", async () => {
  const { post, rows } = await fixture();
  await db
    .update(schema.taskTable)
    .set({ description: null, priority: null })
    .where(eq(schema.taskTable.id, "ordered-00000"));
  expect((await post("ordered-00000", { expectedVersion: 2 })).status).toBe(
    200,
  );
  expect(
    (await rows()).find((task) => task.id === "ordered-00000"),
  ).toMatchObject({ description: null, priority: null, version: 3 });
});
it("appends sixteen concurrent creations with distinct positions", async () => {
  const { app, project, rows } = await fixture();
  const responses = await Promise.all(
    Array.from({ length: 16 }, (_, i) =>
      app.request(`/api/task/${project.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `Created ${i}`,
          description: "Created prose",
          status: "to-do",
          priority: "low",
        }),
      }),
    ),
  );
  expect(responses.map((response) => response.status)).toEqual(
    Array(16).fill(200),
  );
  const after = await rows();
  expect(after).toHaveLength(21);
  expect(new Set(after.map((task) => task.position)).size).toBe(21);
});
it("rejects foreign anchors, invalid statuses, self anchors and missing operation keys", async () => {
  const { post, rows, app, project } = await fixture();
  const other = await createWorkspaceMember();
  const { project: otherProject } = await createProjectFixture({
    workspaceId: other.workspace.id,
  });
  await db.insert(schema.taskTable).values({
    id: "foreign",
    projectId: otherProject.id,
    number: 1,
    title: "Private",
    status: "to-do",
  });
  const before = await rows();
  expect(
    (
      await post("ordered-00000", {
        anchor: { id: "foreign", expectedVersion: 1, placement: "after" },
      })
    ).status,
  ).toBe(409);
  expect((await post("ordered-00000", { status: "invalid" })).status).toBe(400);
  expect(
    (
      await post("ordered-00000", {
        anchor: { id: "ordered-00000", expectedVersion: 1, placement: "after" },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await app.request("/api/task/agent/order/ordered-00000", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          expectedVersion: 1,
          status: "to-do",
        }),
      })
    ).status,
  ).toBe(400);
  expect(await rows()).toEqual(before);
});
it("uses integer gap without changing neighbors or their revisions", async () => {
  const { post, rows } = await fixture();
  await db
    .update(schema.taskTable)
    .set({ position: 100 })
    .where(eq(schema.taskTable.id, "ordered-00001"));
  const before = await rows();
  const response = await post("ordered-00004", {
    anchor: { id: "ordered-00001", expectedVersion: 2, placement: "before" },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ position: 51, version: 2 });
  expect((await rows()).filter((task) => task.id !== "ordered-00004")).toEqual(
    before.filter((task) => task.id !== "ordered-00004"),
  );
});
it.each(["ties", "nulls", "overflow"])(
  "falls back to atomic ordering for %s",
  async (kind) => {
    const { post, rows } = await fixture();
    if (kind === "nulls")
      await db.update(schema.taskTable).set({ position: null });
    else if (kind === "overflow")
      await db
        .update(schema.taskTable)
        .set({ position: 2147483647 })
        .where(eq(schema.taskTable.id, "ordered-00004"));
    else {
      await db
        .update(schema.taskTable)
        .set({ position: 10 })
        .where(eq(schema.taskTable.id, "ordered-00001"));
      await db
        .update(schema.taskTable)
        .set({ position: 10 })
        .where(eq(schema.taskTable.id, "ordered-00002"));
    }
    const anchorId =
      kind === "nulls"
        ? "ordered-00002"
        : kind === "overflow"
          ? "ordered-00004"
          : "ordered-00001";
    const response = await post("ordered-00000", {
      expectedVersion: kind === "nulls" ? 2 : 1,
      anchor: { id: anchorId, expectedVersion: 2, placement: "after" },
    });
    expect(response.status).toBe(200);
    const after = await rows();
    const index = after.findIndex((task) => task.id === anchorId);
    expect(after[index + 1].id).toBe("ordered-00000");
    expect(new Set(after.map((task) => task.position)).size).toBe(5);
  },
);
