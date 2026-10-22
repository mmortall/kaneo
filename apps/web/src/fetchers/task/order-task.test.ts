import { beforeEach, expect, it, vi } from "vitest";
import orderTask from "./order-task";
import { TaskConflictError } from "./update-task";

const mocks = vi.hoisted(() => ({ capability: vi.fn(), post: vi.fn() }));
vi.mock("@kaneo/libs", () => ({
  client: {
    task: {
      agent: {
        capabilities: { $get: mocks.capability },
        order: { ":id": { $post: mocks.post } },
      },
    },
  },
}));
const input = {
  task: { id: "task", projectId: "project", version: 7 },
  status: "to-do",
  anchor: {
    task: { id: "anchor", projectId: "project", version: 9 },
    placement: "after" as const,
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.capability.mockResolvedValue(
    Response.json({ relativeTaskOrdering: true }),
  );
  mocks.post.mockResolvedValue(
    Response.json({ id: "task", version: 8, position: 100 }),
  );
});
it("sends one relative write with caller and anchor revisions, not neighbors", async () => {
  await orderTask(input);
  expect(mocks.post).toHaveBeenCalledTimes(1);
  expect(mocks.post.mock.calls[0][0]).toEqual({
    param: { id: "task" },
    json: {
      projectId: "project",
      expectedVersion: 7,
      status: "to-do",
      anchor: { id: "anchor", expectedVersion: 9, placement: "after" },
    },
  });
  expect(mocks.post.mock.calls[0][1].headers["Idempotency-Key"]).toMatch(
    /^[0-9a-f-]{36}$/,
  );
  expect(mocks.post.mock.calls[0][1].init.signal).toBe(
    mocks.capability.mock.calls[0][1].init.signal,
  );
});
it("rejects missing anchor revision before requests", async () => {
  await expect(
    orderTask({
      ...input,
      anchor: {
        ...input.anchor,
        task: { ...input.anchor.task, version: undefined },
      },
    }),
  ).rejects.toThrow("version is missing");
  expect(mocks.capability).not.toHaveBeenCalled();
  expect(mocks.post).not.toHaveBeenCalled();
});
it("does not downgrade to unsafe ordering on old servers", async () => {
  mocks.capability.mockResolvedValue(Response.json({ taskRevisions: true }));
  await expect(orderTask(input)).rejects.toThrow("does not support");
  expect(mocks.post).not.toHaveBeenCalled();
});
it("surfaces stale ordering without rereading or retrying", async () => {
  mocks.post.mockResolvedValue(
    Response.json({ error: "TASK_CONFLICT" }, { status: 409 }),
  );
  await expect(orderTask(input)).rejects.toBeInstanceOf(TaskConflictError);
  expect(mocks.post).toHaveBeenCalledTimes(1);
});
