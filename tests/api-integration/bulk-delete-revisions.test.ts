import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import bulkUpdateTasks from "../../apps/api/src/task/controllers/bulk-update-tasks";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const mocks = vi.hoisted(() => ({ emit: vi.fn(), cleanup: vi.fn() }));
vi.mock("../../apps/api/src/events", async (original) => ({
  ...(await original<typeof import("../../apps/api/src/events")>()),
  publishEvent: mocks.emit,
}));
vi.mock("../../apps/api/src/storage/cleanup-assets", async (original) => ({
  ...(await original<
    typeof import("../../apps/api/src/storage/cleanup-assets")
  >()),
  deleteS3Keys: mocks.cleanup,
}));
describe("Atomic versioned selected deletion", () => {
  beforeEach(resetTestDatabase);
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.emit.mockResolvedValue(undefined);
    mocks.cleanup.mockResolvedValue([]);
  });
  async function fixture(count = 2) {
    const member = await createWorkspaceMember({ role: "owner" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const tasks = await db
      .insert(schema.taskTable)
      .values(
        Array.from({ length: count + 1 }, (_, i) => ({
          projectId: project.id,
          title: `Task ${i}`,
          description: `Prose ${i}`,
          status: "to-do",
          number: i + 1,
        })),
      )
      .returning();
    const selected = tasks.slice(0, count);
    const untouched = tasks[count]!;
    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const input = {
      taskIds: selected.map((task) => task.id),
      operation: "delete" as const,
      expectedVersions: selected.map((task) => ({
        id: task.id,
        version: task.version,
      })),
      userId: member.user.id,
      workspaceId: member.workspace.id,
    };
    const request = (body: object = input) =>
      app.request("/api/task/bulk", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const rows = () =>
      db
        .select()
        .from(schema.taskTable)
        .where(eq(schema.taskTable.projectId, project.id))
        .orderBy(schema.taskTable.id);
    return { member, project, selected, untouched, input, request, rows };
  }
  it("rejects stale whole selection with no deletes or effects", async () => {
    const { selected, request, rows } = await fixture();
    await db
      .update(schema.taskTable)
      .set({ description: "New agent text" })
      .where(eq(schema.taskTable.id, selected[0]!.id));
    const before = await rows();
    expect((await request()).status).toBe(409);
    expect(await rows()).toEqual(before);
    expect(mocks.emit).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });
  it("deletes selected100 atomically while leaving other task unchanged", async () => {
    const { request, rows, untouched } = await fixture(100);
    expect(await (await request()).json()).toEqual({
      success: true,
      updatedCount: 100,
    });
    expect(await rows()).toEqual([untouched]);
    expect(
      mocks.emit.mock.calls.filter((call) => call[0] === "task.deleted"),
    ).toHaveLength(100);
  });
  it("commits only one of16 same-snapshot deletion requests", async () => {
    const { request, rows, untouched } = await fixture();
    const responses = await Promise.all(
      Array.from({ length: 16 }, () => request()),
    );
    expect(
      responses.filter((response) => response.status === 200),
    ).toHaveLength(1);
    expect(
      responses.every((response) => [200, 404, 409].includes(response.status)),
    ).toBe(true);
    expect(await rows()).toEqual([untouched]);
    expect(
      mocks.emit.mock.calls.filter((call) => call[0] === "task.deleted"),
    ).toHaveLength(2);
  });
  it("concurrent edits and deletes cannot erase a committed newer edit", async () => {
    const { input, request, selected, untouched, rows } = await fixture();
    const { app } = createApp();
    const results = await Promise.all([
      ...Array.from({ length: 8 }, async () => ({
        kind: "delete",
        response: await request(),
      })),
      ...Array.from({ length: 8 }, async () => ({
        kind: "edit",
        response: await app.request(`/api/task/agent/${selected[0]!.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedVersion: input.expectedVersions[0]!.version,
            title: "New agent edit",
          }),
        }),
      })),
    ]);
    expect(
      results.every((result) =>
        [200, 404, 409].includes(result.response.status),
      ),
    ).toBe(true);
    const deletes = results.filter(
      (result) => result.kind === "delete" && result.response.status === 200,
    ).length;
    const edits = results.filter(
      (result) => result.kind === "edit" && result.response.status === 200,
    ).length;
    expect(deletes + edits).toBe(1);
    const after = await rows();
    if (deletes) expect(after).toEqual([untouched]);
    else {
      expect(after).toHaveLength(3);
      expect(after.find((task) => task.id === selected[0]!.id)).toMatchObject({
        title: "New agent edit",
        version: selected[0]!.version + 1,
        description: selected[0]!.description,
      });
    }
  });

  it("rejects missing/duplicate revisions and missing task without partial delete", async () => {
    const { input, request, rows } = await fixture();
    const before = await rows();
    expect(
      (await request({ ...input, expectedVersions: undefined })).status,
    ).toBe(400);
    expect(
      (
        await request({
          ...input,
          expectedVersions: [
            input.expectedVersions[0],
            input.expectedVersions[0],
          ],
        })
      ).status,
    ).toBe(400);
    await db
      .delete(schema.taskTable)
      .where(eq(schema.taskTable.id, input.taskIds[0]!));
    const remaining = await rows();
    expect((await request()).status).not.toBe(200);
    expect(await rows()).toEqual(remaining);
    expect(before).toHaveLength(3);
  });
  it("captures relation events and file cleanup only after committed deletion", async () => {
    const { member, project, selected, untouched, request } = await fixture();
    await db.insert(schema.assetTable).values({
      taskId: selected[0]!.id,
      projectId: project.id,
      workspaceId: member.workspace.id,
      objectKey: "selected-file",
      filename: "file.png",
      mimeType: "image/png",
      size: 10,
    });
    await db.insert(schema.taskRelationTable).values({
      sourceTaskId: selected[0]!.id,
      targetTaskId: untouched.id,
      relationType: "related",
    });
    expect((await request()).status).toBe(200);
    expect(mocks.cleanup).toHaveBeenCalledWith(["selected-file"]);
    expect(
      mocks.emit.mock.calls.filter(
        (call) => call[0] === "task-relation.deleted",
      ),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(schema.assetTable)
        .where(
          inArray(
            schema.assetTable.taskId,
            selected.map((task) => task.id),
          ),
        ),
    ).toEqual([]);
    expect(await db.select().from(schema.taskRelationTable)).toEqual([]);
  });

  it("rechecks permission in controller transaction", async () => {
    const { member, input, rows } = await fixture();
    const before = await rows();
    await db
      .update(schema.workspaceUserTable)
      .set({ role: "viewer" })
      .where(eq(schema.workspaceUserTable.userId, member.user.id));
    await expect(bulkUpdateTasks(input)).rejects.toMatchObject({ status: 403 });
    expect(await rows()).toEqual(before);
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
