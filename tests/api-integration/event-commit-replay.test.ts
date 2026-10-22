import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

async function drainEvents() {
  await vi.waitFor(
    () => expect(events.eventBusSnapshot().activeHandlers).toBe(0),
    {
      timeout: 5000,
    },
  );
}

async function fixture() {
  const member = await createWorkspaceMember();
  const { project, columns } = await createProjectFixture({
    workspaceId: member.workspace.id,
  });
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId: project.id,
      title: "Original",
      goal: "Verify replay",
      acceptanceCriteria: "One committed mutation",
      status: "to-do",
      columnId: columns.todo.id,
      number: 1,
    })
    .returning();
  mockAuthenticatedSession(member.user);
  return { task: task!, app: createApp().app };
}

describe("Committed mutations under event publication faults", () => {
  beforeEach(async () => {
    await drainEvents();
    await resetTestDatabase();
  });
  afterEach(drainEvents);

  for (const delivered of [false, true]) {
    it(`replays committed status without duplicate activity after ${delivered ? "post" : "pre"}-emit failure`, async () => {
      const { task, app } = await fixture();
      const original = events.publishEvent;
      const publisher = vi
        .spyOn(events, "publishEvent")
        .mockImplementation(async (type, data) => {
          if (type === "task.status_changed") {
            if (delivered) await original(type, data);
            throw new Error(
              "Injected publication failure after database commit",
            );
          }
          await original(type, data);
        });
      const request = {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-kaneo-caller": "ai",
          "Idempotency-Key": "status-event-fault",
        },
        body: JSON.stringify({
          expectedVersion: task.version,
          status: "in-progress",
        }),
      };
      expect(
        (await app.request(`/api/task/agent/${task.id}`, request)).status,
      ).toBe(500);
      await drainEvents();
      const committed = await db.query.taskTable.findFirst({
        where: eq(schema.taskTable.id, task.id),
      });
      expect(committed).toMatchObject({
        status: "in-progress",
        version: task.version + 1,
      });
      const operations = await db.select().from(taskOperationTable);
      expect(operations).toHaveLength(1);
      const emitted = publisher.mock.calls.length;
      const replay = await app.request(`/api/task/agent/${task.id}`, request);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({
        id: task.id,
        status: "in-progress",
        version: task.version + 1,
      });
      expect(publisher).toHaveBeenCalledTimes(emitted);
      expect(await db.select().from(taskOperationTable)).toHaveLength(1);
      const activity = await db
        .select()
        .from(schema.activityTable)
        .where(
          and(
            eq(schema.activityTable.taskId, task.id),
            eq(schema.activityTable.type, "status_changed"),
          ),
        );
      // Replay protects the mutation; it does not redeliver lost events.
      expect(activity).toHaveLength(delivered ? 1 : 0);
      expect(
        (
          await db.query.taskTable.findFirst({
            where: eq(schema.taskTable.id, task.id),
          })
        )?.version,
      ).toBe(task.version + 1);
    });

    it(`replays one durable comment after ${delivered ? "post" : "pre"}-emit failure`, async () => {
      const { task, app } = await fixture();
      const original = events.publishEvent;
      const publisher = vi
        .spyOn(events, "publishEvent")
        .mockImplementation(async (type, data) => {
          if (type === "comment.created") {
            if (delivered) await original(type, data);
            throw new Error("Injected comment publication failure");
          }
          await original(type, data);
        });
      const request = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "comment-event-fault",
        },
        body: JSON.stringify({ content: "One durable completion" }),
      };
      expect(
        (await app.request(`/api/comment/${task.id}`, request)).status,
      ).toBe(500);
      await drainEvents();
      const comments = await db
        .select()
        .from(schema.activityTable)
        .where(eq(schema.activityTable.taskId, task.id));
      expect(comments).toHaveLength(1);
      const emitted = publisher.mock.calls.length;
      const replay = await app.request(`/api/comment/${task.id}`, request);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({
        id: comments[0]!.id,
        content: "One durable completion",
      });
      expect(publisher).toHaveBeenCalledTimes(emitted);
      expect(
        await db
          .select()
          .from(schema.activityTable)
          .where(eq(schema.activityTable.taskId, task.id)),
      ).toHaveLength(1);
    });
  }

  for (const delivered of [false, true]) {
    it(`replays one relation after ${delivered ? "post" : "pre"}-emit failure`, async () => {
      const { task, app } = await fixture();
      const [target] = await db
        .insert(schema.taskTable)
        .values({
          projectId: task.projectId,
          title: "Related task",
          number: 2,
        })
        .returning();
      const original = events.publishEvent;
      const publisher = vi
        .spyOn(events, "publishEvent")
        .mockImplementation(async (type, data) => {
          if (type === "task-relation.created") {
            if (delivered) await original(type, data);
            throw new Error("Injected relation publication failure");
          }
          await original(type, data);
        });
      const request = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": "relation-event-fault",
        },
        body: JSON.stringify({
          sourceTaskId: task.id,
          targetTaskId: target!.id,
          relationType: "related",
        }),
      };
      expect((await app.request("/api/task-relation", request)).status).toBe(
        500,
      );
      await drainEvents();
      const relations = await db.select().from(schema.taskRelationTable);
      expect(relations).toHaveLength(1);
      expect(await db.select().from(taskOperationTable)).toHaveLength(1);
      const emitted = publisher.mock.calls.length;
      const replay = await app.request("/api/task-relation", request);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ id: relations[0]!.id });
      expect(publisher).toHaveBeenCalledTimes(emitted);
      expect(await db.select().from(schema.taskRelationTable)).toHaveLength(1);
      expect(await db.select().from(taskOperationTable)).toHaveLength(1);
    });
  }

  it("isolates a real subscriber failure without blocking another subscriber", async () => {
    const type = "test.commit-audit.subscriber-fault";
    const error = new Error("Injected subscriber failure");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const healthy = vi.fn(async () => {});
    await events.subscribeToEvent(type, async () => {
      throw error;
    });
    await events.subscribeToEvent(type, healthy);
    await expect(
      events.publishEvent(type, { value: 1 }),
    ).resolves.toBeUndefined();
    await drainEvents();
    expect(healthy).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(`Error processing event ${type}:`, error);
  });
});
