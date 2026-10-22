import { eq } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";
import deleteColumn from "../../apps/api/src/column/controllers/delete-column";
import db, { schema } from "../../apps/api/src/database";
import { taskGroupEventTable } from "../../apps/api/src/database/schema";
import applyTaskGroup from "../../apps/api/src/task/controllers/apply-task-group";
import prepareTaskGroup from "../../apps/api/src/task/controllers/prepare-task-group";
import updateTask from "../../apps/api/src/task/controllers/update-task";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

beforeEach(resetTestDatabase);

it("sixteen empty-column deletions yield one deletion and explicit not-found responses", async () => {
  const member = await createWorkspaceMember({ role: "owner" });
  const { columns } = await createProjectFixture({
    workspaceId: member.workspace.id,
  });
  const results = await Promise.allSettled(
    Array.from({ length: 16 }, () => deleteColumn(columns.done.id)),
  );
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  for (const result of results)
    if (result.status === "rejected")
      expect(result.reason).toMatchObject({ status: 404 });
  expect(
    await db.query.columnTable.findFirst({
      where: eq(schema.columnTable.id, columns.done.id),
    }),
  ).toBeUndefined();
});

it("column deletion still rejects explicit foreign-key reference even when status differs", async () => {
  const member = await createWorkspaceMember({ role: "owner" });
  const { project, columns } = await createProjectFixture({
    workspaceId: member.workspace.id,
  });
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId: project.id,
      title: "Mismatched legacy reference",
      status: "planned",
      columnId: columns.done.id,
    })
    .returning();
  await expect(deleteColumn(columns.done.id)).rejects.toMatchObject({
    status: 409,
  });
  expect(
    await db.query.taskTable.findFirst({
      where: eq(schema.taskTable.id, task.id),
    }),
  ).toEqual(task);
});

it.each(["done", "to-do"])(
  "cannot delete %s column occupied by legacy status-only task",
  async (status) => {
    const member = await createWorkspaceMember({ role: "owner" });
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });
    const column = status === "done" ? columns.done : columns.todo;
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Legacy task",
        status,
        columnId: null,
      })
      .returning();
    await expect(deleteColumn(column.id)).rejects.toMatchObject({
      status: 409,
    });
    expect(
      await db.query.columnTable.findFirst({
        where: eq(schema.columnTable.id, column.id),
      }),
    ).toEqual(column);
    expect(
      await db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, task.id),
      }),
    ).toEqual(task);
  },
);

it("archive racing source deletion never loses source workflow before applied result", async () => {
  const member = await createWorkspaceMember({ role: "owner" });
  const { project, columns } = await createProjectFixture({
    workspaceId: member.workspace.id,
  });
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId: project.id,
      title: "Completed",
      status: "done",
      columnId: null,
    })
    .returning();
  const prepared = await prepareTaskGroup(
    project.id,
    { action: "archive_column", sourceStatus: "done" },
    member.user.id,
    member.workspace.id,
    "column-race",
  );
  const [archive, deletion] = await Promise.allSettled([
    applyTaskGroup(
      project.id,
      String(prepared.operationId),
      member.user.id,
      member.workspace.id,
    ),
    deleteColumn(columns.done.id),
  ]);
  expect(archive.status).toBe("fulfilled");
  if (archive.status === "fulfilled")
    expect(archive.value).toMatchObject({ applied: true, updatedCount: 1 });
  if (deletion.status === "rejected")
    expect(deletion.reason).toMatchObject({ status: 409 });
  const after = await db.query.taskTable.findFirst({
    where: eq(schema.taskTable.id, task.id),
  });
  expect(after).toMatchObject({
    status: "archived",
    version: task.version + 1,
    columnId: null,
  });
});

it("planned activation racing destination deletion either commits valid column or rejects unchanged", async () => {
  const member = await createWorkspaceMember({ role: "owner" });
  const { project, columns } = await createProjectFixture({
    workspaceId: member.workspace.id,
  });
  const [task] = await db
    .insert(schema.taskTable)
    .values({ projectId: project.id, title: "Planned", status: "planned" })
    .returning();
  const prepared = await prepareTaskGroup(
    project.id,
    { action: "activate_planned", targetStatus: "to-do" },
    member.user.id,
    member.workspace.id,
    "target-race",
  );
  const [activation, deletion] = await Promise.allSettled([
    applyTaskGroup(
      project.id,
      String(prepared.operationId),
      member.user.id,
      member.workspace.id,
    ),
    deleteColumn(columns.todo.id),
  ]);
  const after = await db.query.taskTable.findFirst({
    where: eq(schema.taskTable.id, task.id),
  });
  const column = await db.query.columnTable.findFirst({
    where: eq(schema.columnTable.id, columns.todo.id),
  });
  if (activation.status === "fulfilled") {
    expect(activation.value).toMatchObject({ applied: true, updatedCount: 1 });
    expect(after).toMatchObject({
      status: "to-do",
      columnId: columns.todo.id,
      version: task.version + 1,
    });
    expect(column).toBeDefined();
    expect(deletion.status).toBe("rejected");
    if (deletion.status === "rejected")
      expect(deletion.reason).toMatchObject({ status: 409 });
  } else {
    expect(activation.reason).toMatchObject({ status: 409 });
    expect(after).toEqual(task);
    expect(deletion.status).toBe("fulfilled");
    expect(column).toBeUndefined();
  }
});

it("eight group calls and eight sparse edits share revisions without lost title or raw database errors", async () => {
  const member = await createWorkspaceMember({ role: "owner" });
  const { project, columns } = await createProjectFixture({
    workspaceId: member.workspace.id,
  });
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId: project.id,
      title: "Original",
      description: "Keep prose",
      status: "done",
      columnId: columns.done.id,
    })
    .returning();
  const prepared = await prepareTaskGroup(
    project.id,
    { action: "archive_column", sourceStatus: "done" },
    member.user.id,
    member.workspace.id,
    "edit-race",
  );
  const calls = Array.from({ length: 16 }, (_, index) =>
    index % 2 === 0
      ? applyTaskGroup(
          project.id,
          String(prepared.operationId),
          member.user.id,
          member.workspace.id,
        )
      : updateTask(
          task.id,
          "Edited",
          task.status,
          undefined,
          undefined,
          project.id,
          task.description,
          task.priority,
          task.position,
          undefined,
          undefined,
          undefined,
          undefined,
          member.user.id,
          {},
          undefined,
          {
            expectedVersion: task.version,
            workspaceId: member.workspace.id,
            partialFields: ["title"],
            skipEvents: true,
          },
        ),
  );
  const results = await Promise.allSettled(calls);
  for (const result of results)
    if (result.status === "rejected")
      expect(result.reason).toMatchObject({ status: 409 });
  const after = await db.query.taskTable.findFirst({
    where: eq(schema.taskTable.id, task.id),
  });
  expect(after).toMatchObject({
    version: task.version + 1,
    description: task.description,
  });
  const groupSuccesses = results.filter(
    (result, index) => index % 2 === 0 && result.status === "fulfilled",
  );
  const editSuccesses = results.filter(
    (result, index) => index % 2 === 1 && result.status === "fulfilled",
  );
  if (groupSuccesses.length) {
    expect(groupSuccesses).toHaveLength(8);
    expect(editSuccesses).toHaveLength(0);
    expect(after).toMatchObject({
      status: "archived",
      title: "Original",
      columnId: null,
    });
    expect(await db.select().from(taskGroupEventTable)).toHaveLength(1);
  } else {
    expect(editSuccesses).toHaveLength(1);
    expect(after).toMatchObject({
      status: "done",
      title: "Edited",
      columnId: columns.done.id,
    });
    expect(await db.select().from(taskGroupEventTable)).toHaveLength(0);
  }
});
