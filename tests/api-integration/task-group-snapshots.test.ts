import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { projectTaskOperationTable } from "../../apps/api/src/database/schema";
import prepareTaskGroup from "../../apps/api/src/task/controllers/prepare-task-group";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

describe("Durable complete task group snapshots", () => {
  beforeEach(resetTestDatabase);
  async function fixture() {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const prepare = (key = "snapshot") =>
      prepareTaskGroup(
        project.id,
        { action: "archive_column", sourceStatus: "done" },
        member.user.id,
        member.workspace.id,
        key,
      );
    return { member, project, prepare };
  }
  it("captures complete status group from20000 tasks with bounded response and zero business changes", async () => {
    const { project, prepare } = await fixture();
    await db.execute(sql`INSERT INTO task(id, project_id, number, title, description, status, version)
      SELECT 'group-task-' || i, ${project.id}, i, 'Task ' || i, repeat('large prose ', 100),
        CASE WHEN i <= 10000 THEN 'done' WHEN i <= 15000 THEN 'planned' ELSE 'to-do' END, 1
      FROM generate_series(1, 20000) AS i`);
    const result = await prepare();
    expect(result.count).toBe(10000);
    expect(JSON.stringify(result).length).toBeLessThan(700);
    expect(result).not.toHaveProperty("snapshot");
    const [operation] = await db.select().from(projectTaskOperationTable);
    expect(operation.snapshot).toHaveLength(10000);
    expect(new Set(operation.snapshot.map((row) => row.id)).size).toBe(10000);
    expect(operation.snapshot.every((row) => row.version === 1)).toBe(true);
    const rows = await db
      .select({
        version: schema.taskTable.version,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.taskTable)
      .groupBy(schema.taskTable.version);
    expect(rows).toEqual([{ version: 1, count: 20000 }]);
  });
  it("sixteen identical preparations create one ledger record and identical result", async () => {
    const { project, prepare } = await fixture();
    await db
      .insert(schema.taskTable)
      .values({ projectId: project.id, title: "Done", status: "done" });
    const results = await Promise.all(
      Array.from({ length: 16 }, () => prepare()),
    );
    for (const result of results) expect(result).toEqual(results[0]);
    expect(await db.select().from(projectTaskOperationTable)).toHaveLength(1);
  });
  it("replay preserves original revisions/set after task changes and deletion", async () => {
    const { project, prepare } = await fixture();
    const [task] = await db
      .insert(schema.taskTable)
      .values({ projectId: project.id, title: "Done", status: "done" })
      .returning();
    const result = await prepare();
    const [before] = await db.select().from(projectTaskOperationTable);
    await db
      .update(schema.taskTable)
      .set({ title: "Changed" })
      .where(eq(schema.taskTable.id, task!.id));
    await db.delete(schema.taskTable).where(eq(schema.taskTable.id, task!.id));
    await db
      .insert(schema.taskTable)
      .values({ projectId: project.id, title: "New done", status: "done" });
    expect(await prepare()).toEqual(result);
    expect(await db.select().from(projectTaskOperationTable)).toEqual([before]);
    expect(before.snapshot).toEqual([{ id: task!.id, version: task!.version }]);
  });
  it("empty group remains durable and independent new keys capture new tasks", async () => {
    const { project, prepare } = await fixture();
    expect((await prepare()).count).toBe(0);
    await db
      .insert(schema.taskTable)
      .values({ projectId: project.id, title: "New done", status: "done" });
    expect((await prepare()).count).toBe(0);
    expect((await prepare("new-snapshot")).count).toBe(1);
    expect(await db.select().from(projectTaskOperationTable)).toHaveLength(2);
  });
  it("same caller key with different intent conflicts without replacing snapshot", async () => {
    const { member, project, prepare } = await fixture();
    await prepare();
    const before = await db.select().from(projectTaskOperationTable);
    await expect(
      prepareTaskGroup(
        project.id,
        { action: "activate_planned", targetStatus: "to-do" },
        member.user.id,
        member.workspace.id,
        "snapshot",
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(projectTaskOperationTable)).toEqual(before);
  });
  it("validates final source/target, membership/workspace and key before persisting", async () => {
    const { member, project, prepare } = await fixture();
    await expect(prepare("")).rejects.toMatchObject({ status: 400 });
    await expect(
      prepareTaskGroup(
        project.id,
        { action: "archive_column", sourceStatus: "to-do" },
        member.user.id,
        member.workspace.id,
        "not-final",
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      prepareTaskGroup(
        project.id,
        { action: "activate_planned", targetStatus: "missing" },
        member.user.id,
        member.workspace.id,
        "missing-target",
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      prepareTaskGroup(
        project.id,
        { action: "archive_column", sourceStatus: "done" },
        "missing-user",
        member.workspace.id,
        "unauthorized",
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      prepareTaskGroup(
        project.id,
        { action: "archive_column", sourceStatus: "done" },
        member.user.id,
        "wrong-workspace",
        "wrong-scope",
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(await db.select().from(projectTaskOperationTable)).toEqual([]);
  });
  it("expired preparation fails explicitly instead of silently taking new snapshot", async () => {
    const { prepare } = await fixture();
    const result = await prepare();
    await db
      .update(projectTaskOperationTable)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(projectTaskOperationTable.id, String(result.operationId)));
    const before = await db.select().from(projectTaskOperationTable);
    await expect(prepare()).rejects.toMatchObject({ status: 410 });
    expect(await db.select().from(projectTaskOperationTable)).toEqual(before);
  });
  it("planned snapshot includes all planned tasks and resolves destination column", async () => {
    const { member, project } = await fixture();
    const [task] = await db
      .insert(schema.taskTable)
      .values({ projectId: project.id, title: "Planned", status: "planned" })
      .returning();
    const result = await prepareTaskGroup(
      project.id,
      { action: "activate_planned", targetStatus: "in-progress" },
      member.user.id,
      member.workspace.id,
      "planned",
    );
    expect(result).toMatchObject({
      count: 1,
      sourceStatus: "planned",
      targetStatus: "in-progress",
      sourceColumnId: null,
      applied: false,
    });
    const target = await db.query.columnTable.findFirst({
      where: eq(schema.columnTable.id, String(result.targetColumnId)),
    });
    expect(target).toMatchObject({
      projectId: project.id,
      slug: "in-progress",
    });
    expect(
      await db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, task!.id),
      }),
    ).toEqual(task);
  });
  it("same key from different workspace members creates separate owned snapshots", async () => {
    const { member, project, prepare } = await fixture();
    const [other] = await db
      .insert(schema.userTable)
      .values({
        id: "group-other-user",
        name: "Other",
        email: "group-other@example.test",
      })
      .returning();
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: member.workspace.id,
      userId: other!.id,
      role: "member",
      joinedAt: new Date(),
    });
    const first = await prepare();
    const second = await prepareTaskGroup(
      project.id,
      { action: "archive_column", sourceStatus: "done" },
      other!.id,
      member.workspace.id,
      "snapshot",
    );
    expect(second.operationId).not.toBe(first.operationId);
    const operations = await db.select().from(projectTaskOperationTable);
    expect(operations).toHaveLength(2);
    expect(new Set(operations.map((row) => row.userId))).toEqual(
      new Set([member.user.id, other!.id]),
    );
  });
});
