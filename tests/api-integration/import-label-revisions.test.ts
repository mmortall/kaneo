import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import importTaskLabels from "../../apps/api/src/label/controllers/import-task-labels";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

describe("Provider label import revisions", () => {
  beforeEach(resetTestDatabase);
  async function fixture() {
    const member = await createWorkspaceMember({ role: "owner" });
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Task",
        description: "Keep prose",
        status: "to-do",
      })
      .returning();
    const apply = (
      labels: { name: string; color: string }[],
      mode: "append" | "replace" = "append",
    ) => importTaskLabels(task!.id, member.workspace.id, labels, mode);
    const row = () =>
      db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, task!.id),
      });
    const labels = () =>
      db
        .select()
        .from(schema.labelTable)
        .where(eq(schema.labelTable.taskId, task!.id))
        .orderBy(schema.labelTable.name);
    return { member, task: task!, apply, row, labels };
  }
  it("appends labels while preserving existing copies and stable replay revision", async () => {
    const { task, member, apply, row, labels } = await fixture();
    await db.insert(schema.labelTable).values({
      name: "Existing",
      color: "blue",
      taskId: task.id,
      workspaceId: member.workspace.id,
    });
    expect(
      await apply([
        { name: "New", color: "red" },
        { name: "New", color: "green" },
      ]),
    ).toEqual({ changed: 1 });
    const after = await row();
    expect(after).toEqual({
      ...task,
      version: task.version + 1,
      updatedAt: after!.updatedAt,
    });
    expect((await labels()).map((label) => [label.name, label.color])).toEqual([
      ["Existing", "blue"],
      ["New", "red"],
    ]);
    expect(await apply([{ name: "New", color: "green" }])).toEqual({
      changed: 0,
    });
    expect(await row()).toEqual(after);
  });
  it("replaces label set and clears it with one revision increment per change", async () => {
    const { task, member, apply, row, labels } = await fixture();
    await db.insert(schema.labelTable).values(
      [
        { name: "Old", color: "blue" },
        { name: "Kept", color: "green" },
      ].map((label) => ({
        ...label,
        taskId: task.id,
        workspaceId: member.workspace.id,
      })),
    );
    expect(
      await apply(
        [
          { name: "Kept", color: "red" },
          { name: "New", color: "red" },
        ],
        "replace",
      ),
    ).toEqual({ changed: 2 });
    expect((await row())!.version).toBe(task.version + 1);
    expect((await labels()).map((label) => [label.name, label.color])).toEqual([
      ["Kept", "green"],
      ["New", "red"],
    ]);
    expect(await apply([], "replace")).toEqual({ changed: 2 });
    const after = await row();
    expect(after!.version).toBe(task.version + 2);
    expect(await apply([], "replace")).toEqual({ changed: 0 });
    expect(await row()).toEqual(after);
  });
  it("sixteen duplicate imports insert once and advance revision once", async () => {
    const { task, apply, row, labels } = await fixture();
    const results = await Promise.all(
      Array.from({ length: 16 }, () => apply([{ name: "New", color: "red" }])),
    );
    expect(results.filter((result) => result.changed === 1)).toHaveLength(1);
    expect(results.filter((result) => result.changed === 0)).toHaveLength(15);
    expect(await labels()).toHaveLength(1);
    expect((await row())!.version).toBe(task.version + 1);
  });
  it("rejects wrong workspace without touching labels or task", async () => {
    const { task, row, labels } = await fixture();
    await expect(
      importTaskLabels(
        task.id,
        "wrong-workspace",
        [{ name: "New", color: "red" }],
        "append",
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await row()).toEqual(task);
    expect(await labels()).toEqual([]);
  });
  it("rolls back deleted labels when replacement insert violates database constraint", async () => {
    const { task, member, apply, row, labels } = await fixture();
    await db.insert(schema.labelTable).values({
      name: "Old",
      color: "blue",
      taskId: task.id,
      workspaceId: member.workspace.id,
    });
    const before = await labels();
    await expect(
      apply([{ name: "Invalid", color: null as unknown as string }], "replace"),
    ).rejects.toThrow();
    expect(await labels()).toEqual(before);
    expect(await row()).toEqual(task);
  });
  it("uses workspace definition color for new copies", async () => {
    const { member, apply, labels } = await fixture();
    await db.insert(schema.labelTable).values({
      name: "New",
      color: "green",
      workspaceId: member.workspace.id,
    });
    await apply([{ name: "New", color: "red" }]);
    expect((await labels())[0]!.color).toBe("green");
  });
});
