import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAnonymousSession, mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

beforeEach(resetTestDatabase);

it("retains long-name group intent after representative deletion with Unicode and exact color", async () => {
  const member = await createWorkspaceMember();
  const { project } = await createProjectFixture({
    workspaceId: member.workspace.id,
  });
  const name = "Метка😀".repeat(50);
  const color = "蓝";
  await db.insert(schema.taskTable).values([
    {
      id: "stable-a",
      projectId: project.id,
      number: 1,
      title: "A",
      status: "planned",
    },
    {
      id: "stable-b",
      projectId: project.id,
      number: 2,
      title: "B",
      status: "planned",
    },
    {
      id: "stable-blue",
      projectId: project.id,
      number: 3,
      title: "Blue",
      status: "planned",
    },
  ]);
  await db.insert(schema.labelTable).values([
    {
      id: "stable-representative",
      name,
      color,
      workspaceId: member.workspace.id,
      taskId: "stable-a",
    },
    {
      id: "stable-other",
      name,
      color,
      workspaceId: member.workspace.id,
      taskId: "stable-b",
    },
    {
      id: "stable-blue-label",
      name,
      color: "blue",
      workspaceId: member.workspace.id,
      taskId: "stable-blue",
    },
  ]);
  mockAuthenticatedSession(member.user);
  const { app } = createApp();
  const key = createHash("sha256")
    .update(name + "\0" + color)
    .digest("hex");
  const view = (labelGroupKeys: string[], labels?: string[]) =>
    app.request(`/api/task/agent/view/${project.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters: { labelGroupKeys, labels }, limit: 1 }),
    });
  const selected = await view([key]);
  expect(selected.status).toBe(200);
  expect((await selected.json()).pagination).toMatchObject({
    total: 2,
    hasMore: true,
  });
  expect(
    (
      await app.request("/api/label/stable-representative", {
        method: "DELETE",
      })
    ).status,
  ).toBe(200);
  const after = await (await view([key])).json();
  expect(after.pagination.total).toBe(1);
  expect(after.data.plannedTasks.map((task) => task.id)).toEqual(["stable-b"]);
  expect(
    (await (await view([key], ["stable-blue-label"])).json()).pagination.total,
  ).toBe(2);
  expect((await (await view(["0".repeat(64)])).json()).pagination.total).toBe(
    0,
  );
  expect((await view(["bad-key"])).status).toBe(400);
  expect((await view(Array(101).fill(key))).status).toBe(400);
  expect(
    await (await app.request("/api/task/agent/capabilities")).json(),
  ).toMatchObject({ labelGroupKeyViews: true });
});

it("filters complete long-name groups by bounded representative ID within authorized workspace", async () => {
  const member = await createWorkspaceMember();
  const foreign = await createWorkspaceMember();
  const { project } = await createProjectFixture({
    workspaceId: member.workspace.id,
  });
  const name = "x".repeat(257);
  await db.insert(schema.taskTable).values([
    {
      id: "long-group-a",
      projectId: project.id,
      number: 1,
      title: "A",
      status: "planned",
    },
    {
      id: "long-group-b",
      projectId: project.id,
      number: 2,
      title: "B",
      status: "planned",
    },
    {
      id: "long-group-blue",
      projectId: project.id,
      number: 3,
      title: "Blue",
      status: "planned",
    },
  ]);
  await db.insert(schema.labelTable).values([
    {
      id: "long-definition",
      name,
      color: "red",
      workspaceId: member.workspace.id,
    },
    {
      id: "foreign-definition",
      name,
      color: "red",
      workspaceId: foreign.workspace.id,
    },
    {
      id: "long-a-label",
      name,
      color: "red",
      workspaceId: member.workspace.id,
      taskId: "long-group-a",
    },
    {
      id: "long-b-label",
      name,
      color: "red",
      workspaceId: member.workspace.id,
      taskId: "long-group-b",
    },
    {
      id: "long-blue-label",
      name,
      color: "blue",
      workspaceId: member.workspace.id,
      taskId: "long-group-blue",
    },
  ]);
  mockAuthenticatedSession(member.user);
  const { app } = createApp();
  const view = (labelGroupIds: string[], labels?: string[]) =>
    app.request(`/api/task/agent/view/${project.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filters: { labelGroupIds, labels }, limit: 1 }),
    });
  const selected = await view(["long-definition"]);
  expect(selected.status).toBe(200);
  expect((await selected.json()).pagination).toMatchObject({
    total: 2,
    hasMore: true,
  });
  expect(
    (await (await view(["foreign-definition"])).json()).pagination.total,
  ).toBe(0);
  expect(
    (await (await view(["long-definition"], ["long-blue-label"])).json())
      .pagination.total,
  ).toBe(3);
  expect(
    (await view(Array.from({ length: 101 }, (_, i) => String(i)))).status,
  ).toBe(400);
  expect(
    await (await app.request("/api/task/agent/capabilities")).json(),
  ).toMatchObject({ labelGroupIdViews: true });
});

it("pages complete groups with bounded rows across twenty thousand assignments", async () => {
  const member = await createWorkspaceMember();
  const { project } = await createProjectFixture({
    workspaceId: member.workspace.id,
  });
  await db.execute(sql`INSERT INTO task(id,project_id,number,title,status)
    SELECT 'catalogue-task-' || n, ${project.id}, n, 'Catalogue task', 'planned'
    FROM generate_series(1,20000) n`);
  await db.execute(sql`INSERT INTO label(id,name,color,task_id,workspace_id)
    SELECT 'catalogue-label-' || n, 'Shared', CASE WHEN n=1 THEN 'blue' ELSE 'gray' END,
    'catalogue-task-' || n, ${member.workspace.id} FROM generate_series(1,20000) n`);
  await db.insert(schema.labelTable).values([
    {
      id: "shared-definition",
      name: "Shared",
      color: "gray",
      workspaceId: member.workspace.id,
    },
    ...Array.from({ length: 60 }, (_, i) => ({
      name: `Choice${String(i).padStart(2, "0")}`,
      color: "gray",
      workspaceId: member.workspace.id,
    })),
  ]);
  mockAuthenticatedSession(member.user);
  const { app } = createApp();
  const path = `/api/label/workspace/${member.workspace.id}/catalogue`;
  const first = await app.request(path);
  expect(first.status).toBe(200);
  const page1 = await first.json();
  expect(page1.items).toHaveLength(50);
  expect(page1.pagination).toMatchObject({
    total: 62,
    pageSize: 50,
    hasMore: true,
    nextPage: 2,
  });
  const page2 = await (await app.request(path + "?page=2")).json();
  expect(page2.items).toHaveLength(12);
  expect(page2.pagination).toMatchObject({
    total: 62,
    hasMore: false,
    nextPage: null,
  });
  const combined = [...page1.items, ...page2.items];
  expect(
    new Set(combined.map((item) => JSON.stringify([item.name, item.color])))
      .size,
  ).toBe(62);
  expect(
    combined.find((item) => item.name === "Shared" && item.color === "gray"),
  ).toMatchObject({ id: "shared-definition", isWorkspaceLabel: true });
  expect(
    combined.find((item) => item.name === "Shared" && item.color === "blue"),
  ).toMatchObject({ isWorkspaceLabel: false });
  expect(
    combined.every(
      (item) =>
        Object.keys(item).sort().join() === "color,id,isWorkspaceLabel,name",
    ),
  ).toBe(true);
  const definitions = await (
    await app.request(path + "?scope=definitions&limit=100")
  ).json();
  expect(definitions.items).toHaveLength(61);
  expect(definitions.items.every((item) => item.isWorkspaceLabel)).toBe(true);
  const key = createHash("sha256").update("Shared\0gray").digest("hex");
  const filtered = await app.request(`/api/task/agent/view/${project.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filters: { labelGroupKeys: [key] }, limit: 50 }),
  });
  expect(filtered.status).toBe(200);
  const filteredPage = await filtered.json();
  expect(filteredPage.pagination).toMatchObject({
    total: 19_999,
    pageSize: 50,
    hasMore: true,
  });
  expect(filteredPage.data.plannedTasks).toHaveLength(50);
}, 30_000);

it("filters before counts and paging with literal case-insensitive search", async () => {
  const member = await createWorkspaceMember();
  await db.insert(schema.labelTable).values(
    ["Bug%", "BUG_fix", "Other"].map((name) => ({
      name,
      color: "gray",
      workspaceId: member.workspace.id,
    })),
  );
  mockAuthenticatedSession(member.user);
  const { app } = createApp();
  const path = `/api/label/workspace/${member.workspace.id}/catalogue`;
  const result = await (
    await app.request(path + "?search=bug&limit=1&page=2")
  ).json();
  expect(result.pagination).toMatchObject({ total: 2, hasMore: false });
  expect(result.items).toHaveLength(1);
  const literal = await (await app.request(path + "?search=%25")).json();
  expect(literal.items.map((item) => item.name)).toEqual(["Bug%"]);
  const exact = await (
    await app.request(path + "?search=bug%25&exact=true&limit=1")
  ).json();
  expect(exact.pagination.total).toBe(1);
  expect(exact.items.map((item) => item.name)).toEqual(["Bug%"]);
});

it("rejects anonymous and foreign-workspace reads", async () => {
  const member = await createWorkspaceMember();
  const outsider = await createWorkspaceMember();
  const { app } = createApp();
  const path = `/api/label/workspace/${member.workspace.id}/catalogue`;
  mockAnonymousSession();
  expect((await app.request(path)).status).toBe(401);
  mockAuthenticatedSession(outsider.user);
  expect((await app.request(path)).status).toBe(403);
});

it("rejects invalid page sizes and scopes without silently truncating", async () => {
  const member = await createWorkspaceMember();
  mockAuthenticatedSession(member.user);
  const { app } = createApp();
  const path = `/api/label/workspace/${member.workspace.id}/catalogue`;
  for (const query of [
    "limit=101",
    "limit=0",
    "page=0",
    "page=-1",
    "scope=all",
    "search=" + "x".repeat(257),
  ]) {
    expect((await app.request(path + "?" + query)).status).toBe(400);
  }
});
