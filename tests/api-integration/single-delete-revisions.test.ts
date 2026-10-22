import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const mocks = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock("../../apps/api/src/events", async (original) => ({
  ...(await original<typeof import("../../apps/api/src/events")>()),
  publishEvent: mocks.emit,
}));
describe("Single task revision delete", () => {
  beforeEach(resetTestDatabase);
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.emit.mockResolvedValue(undefined);
  });
  async function fixture() {
    const member = await createWorkspaceMember({ role: "owner" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Review",
        description: "Preserved prose",
        status: "to-do",
        number: 1,
      })
      .returning();
    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const request = (version?: number) =>
      app.request(
        `/api/task/${task!.id}${version === undefined ? "" : `?expectedVersion=${version}`}`,
        { method: "DELETE" },
      );
    const row = () =>
      db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, task!.id),
      });
    return { app, task: task!, member, request, row };
  }
  it("requires explicit revision and preserves task on stale delete", async () => {
    const { task, request, row } = await fixture();
    expect((await request()).status).toBe(400);
    await db
      .update(schema.taskTable)
      .set({ description: "New agent prose" })
      .where(eq(schema.taskTable.id, task.id));
    const before = await row();
    expect((await request(task.version)).status).toBe(409);
    expect(await row()).toEqual(before);
    expect(mocks.emit).not.toHaveBeenCalled();
  });
  it("returns reviewed deleted task and emits once among16 requests", async () => {
    const { task, request, row } = await fixture();
    const responses = await Promise.all(
      Array.from({ length: 16 }, () => request(task.version)),
    );
    expect(
      responses.filter((response) => response.status === 200),
    ).toHaveLength(1);
    expect(
      responses.every((response) => [200, 404, 409].includes(response.status)),
    ).toBe(true);
    const success = responses.find((response) => response.status === 200)!;
    expect(await success.json()).toMatchObject({
      id: task.id,
      version: task.version,
      description: "Preserved prose",
    });
    expect(await row()).toBeUndefined();
    expect(
      mocks.emit.mock.calls.filter((call) => call[0] === "task.deleted"),
    ).toHaveLength(1);
  });
  it("keeps authorization before legacy request validation", async () => {
    const { member, request, row } = await fixture();
    await db
      .update(schema.workspaceUserTable)
      .set({ role: "viewer" })
      .where(eq(schema.workspaceUserTable.userId, member.user.id));
    expect((await request()).status).toBe(403);
    expect(await row()).toBeDefined();
  });
});
