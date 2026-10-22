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

describe("Authorized project relation export", () => {
  beforeEach(resetTestDatabase);

  async function fixture() {
    const member = await createWorkspaceMember();
    const outsider = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const { project: other } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const { project: hidden } = await createProjectFixture({
      workspaceId: outsider.workspace.id,
    });
    await db.insert(schema.taskTable).values([
      { id: "edge-root", projectId: project.id, number: 1, title: "Root" },
      ...Array.from({ length: 205 }, (_, i) => ({
        id: `edge-child-${i}`,
        projectId: project.id,
        number: i + 2,
        title: `Child ${i}`,
      })),
      {
        id: "edge-other",
        projectId: other.id,
        number: 1,
        title: "Same workspace",
      },
      {
        id: "edge-other-two",
        projectId: other.id,
        number: 2,
        title: "Unrelated",
      },
      {
        id: "edge-hidden",
        projectId: hidden.id,
        number: 1,
        title: "Other workspace",
      },
    ]);
    await db.insert(schema.taskRelationTable).values([
      ...Array.from({ length: 205 }, (_, i) => ({
        id: `edge-${String(i).padStart(4, "0")}`,
        sourceTaskId: i % 2 ? `edge-child-${i}` : "edge-root",
        targetTaskId: i % 2 ? "edge-root" : `edge-child-${i}`,
        relationType: "related",
      })),
      {
        id: "edge-0205",
        sourceTaskId: "edge-other",
        targetTaskId: "edge-root",
        relationType: "blocks",
      },
      {
        id: "edge-secret",
        sourceTaskId: "edge-root",
        targetTaskId: "edge-hidden",
        relationType: "related",
      },
      {
        id: "edge-unrelated",
        sourceTaskId: "edge-other",
        targetTaskId: "edge-other-two",
        relationType: "related",
      },
    ]);
    mockAuthenticatedSession(member.user);
    return { app: createApp().app, project, hidden };
  }

  it("pages complete incoming/outgoing edges once and matches authorized per-task union", async () => {
    const { app, project } = await fixture();
    const rows: Array<{ id: string }> = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    do {
      const response = await app.request(
        `/api/task/agent/relation-export/${project.id}?limit=100${cursor ? `&cursor=${cursor}` : ""}`,
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      sizes.push(body.relations.length);
      rows.push(...body.relations);
      cursor = body.pagination.nextCursor;
    } while (cursor);
    expect(sizes).toEqual([100, 100, 6]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(206);
    expect(rows.map((r) => r.id)).not.toContain("edge-secret");
    expect(rows.map((r) => r.id)).not.toContain("edge-unrelated");
    const legacy = await app.request("/api/task-relation/edge-root");
    expect(legacy.status).toBe(200);
    expect(new Set(rows.map((r) => r.id))).toEqual(
      new Set((await legacy.json()).map((r: { id: string }) => r.id)),
    );
  });

  it("keeps cursor usable after earlier edge is deleted", async () => {
    const { app, project } = await fixture();
    const first = await (
      await app.request(`/api/task/agent/relation-export/${project.id}?limit=2`)
    ).json();
    await db
      .delete(schema.taskRelationTable)
      .where(eq(schema.taskRelationTable.id, "edge-0001"));
    const next = await (
      await app.request(
        `/api/task/agent/relation-export/${project.id}?limit=2&cursor=${first.pagination.nextCursor}`,
      )
    ).json();
    expect(next.relations.map((r: { id: string }) => r.id)).toEqual([
      "edge-0002",
      "edge-0003",
    ]);
  });

  it("rejects inaccessible project and invalid page bounds", async () => {
    const { app, project, hidden } = await fixture();
    const denied = await app.request(
      `/api/task/agent/relation-export/${hidden.id}`,
    );
    expect([403, 404]).toContain(denied.status);
    for (const limit of ["0", "101", "not-a-number"])
      expect(
        (
          await app.request(
            `/api/task/agent/relation-export/${project.id}?limit=${limit}`,
          )
        ).status,
      ).toBe(400);
    const empty = await (
      await app.request(
        `/api/task/agent/relation-export/${project.id}?cursor=zzzz`,
      )
    ).json();
    expect(empty).toEqual({
      relations: [],
      pagination: { limit: 100, nextCursor: null },
    });
  });
});
