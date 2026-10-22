import { beforeEach, describe, expect, it, vi } from "vitest";
import type Task from "@/types/task";
import moveTask from "./move-task";
import replaceTask from "./update-task";
import updateAssignee from "./update-task-assignee";
import updateDescription from "./update-task-description";
import updateDueDate from "./update-task-due-date";
import updatePriority from "./update-task-priority";
import updateStatus from "./update-task-status";
import updateTitle from "./update-task-title";

const { send, capabilities, state } = vi.hoisted(() => ({
  send: vi.fn(),
  capabilities: vi.fn(),
  state: {
    version: 8,
    description: "Newer prose",
    title: "Newer title",
  } as Record<string, unknown>,
}));
vi.mock("@kaneo/libs", () => ({
  client: {
    task: {
      agent: { ":id": { $patch: send }, capabilities: { $get: capabilities } },
      description: { ":id": { $put: send } },
      title: { ":id": { $put: send } },
      status: { ":id": { $put: send } },
      priority: { ":id": { $put: send } },
      assignee: { ":id": { $put: send } },
      "due-date": { ":id": { $put: send } },
      move: { ":id": { $put: send } },
    },
  },
}));

const cases = [
  ["description", updateDescription, { description: "Edited prose" }],
  ["title", updateTitle, { title: "Edited title" }],
  ["status", updateStatus, { status: "in-progress" }],
  ["priority", updatePriority, { priority: "high" }],
  ["assignee", updateAssignee, { userId: "member" }],
  ["due date", updateDueDate, { dueDate: "2026-10-10T12:00:00.000Z" }],
] as const;

describe("Web caller snapshot revision", () => {
  beforeEach(() => {
    capabilities
      .mockReset()
      .mockResolvedValue(
        new Response(JSON.stringify({ versionedTaskMoves: true })),
      );
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, {
      version: 8,
      title: "Newer title",
      description: "Newer prose",
    });
    send.mockReset().mockImplementation(async ({ json }) => {
      if (
        json.expectedVersion !== undefined &&
        json.expectedVersion !== state.version
      ) {
        return new Response(
          JSON.stringify({
            code: "TASK_CONFLICT",
            currentVersion: state.version,
          }),
          { status: 409 },
        );
      }
      const { expectedVersion: _revision, ...fields } = json;
      Object.assign(state, fields, { version: Number(state.version) + 1 });
      return new Response(JSON.stringify(state));
    });
  });

  for (const [name, update, fields] of cases) {
    it(`${name}: rejects stale intent without changing newer state`, async () => {
      const task = { id: "fixture", version: 7, ...fields } as Task;
      await expect(update(task.id, task)).rejects.toThrow(/changed/i);
      expect(state).toEqual({
        version: 8,
        title: "Newer title",
        description: "Newer prose",
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0].json.expectedVersion).toBe(7);
    });
    it(`${name}: writes only intended field and snapshot revision`, async () => {
      const task = {
        id: "fixture",
        version: 8,
        title: "Unrelated stale title",
        description: "Unrelated stale prose",
        ...fields,
      } as Task;
      await update(task.id, task);
      expect(send.mock.calls[0][0].json).toEqual({
        ...fields,
        expectedVersion: 8,
      });
      expect(state.version).toBe(9);
    });
    it(`${name}: missing revision fails before request`, async () => {
      const task = { id: "fixture", ...fields } as Task;
      await expect(update(task.id, task)).rejects.toThrow(/reload|version/i);
      expect(send).not.toHaveBeenCalled();
    });
  }
  it("summary cannot replace omitted prose even at current revision", async () => {
    await expect(
      replaceTask("fixture", {
        id: "fixture",
        version: 8,
        isSummary: true,
        description: null,
      } as Task),
    ).rejects.toThrow(/summary fields are incomplete/i);
    expect(send).not.toHaveBeenCalled();
    expect(state.description).toBe("Newer prose");
  });
  it("move: rejects stale caller snapshot without moving", async () => {
    await expect(
      moveTask({
        taskId: "fixture",
        destinationProjectId: "next",
        expectedVersion: 7,
      }),
    ).rejects.toThrow(/changed/i);
    expect(state.version).toBe(8);
    expect(state.destinationProjectId).toBeUndefined();
    expect(send.mock.calls[0][0].json.expectedVersion).toBe(7);
  });
  it("move: retains supplied snapshot revision", async () => {
    await moveTask({
      taskId: "fixture",
      destinationProjectId: "next",
      expectedVersion: 8,
    });
    expect(send.mock.calls[0][0].json).toEqual({
      destinationProjectId: "next",
      expectedVersion: 8,
    });
  });
  it("move: missing snapshot stops before request", async () => {
    await expect(
      moveTask({ taskId: "fixture", destinationProjectId: "next" }),
    ).rejects.toThrow(/reload|version/i);
    expect(send).not.toHaveBeenCalled();
  });
  it("move: unsupported API fails before mutation", async () => {
    capabilities.mockResolvedValue(new Response(JSON.stringify({})));
    await expect(
      moveTask({
        taskId: "fixture",
        destinationProjectId: "next",
        expectedVersion: 8,
      }),
    ).rejects.toThrow(/upgrade|support/i);
    expect(send).not.toHaveBeenCalled();
  });
});
