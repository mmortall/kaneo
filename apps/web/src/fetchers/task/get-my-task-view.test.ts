import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ capability: vi.fn(), page: vi.fn() }));
vi.mock("@kaneo/libs", () => ({
  client: {
    task: {
      agent: {
        capabilities: { $get: mocks.capability },
        "my-view": { ":workspaceId": { $post: mocks.page } },
      },
    },
  },
}));

import getMyTaskView from "./get-my-task-view";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capability.mockResolvedValue(
    Response.json({ workspaceTaskViews: true }),
  );
  mocks.page.mockResolvedValue(
    Response.json({
      projects: [
        {
          columns: [{ tasks: [{ id: "task", version: 7 }] }],
          plannedTasks: [],
          blockedTasks: [],
          archivedTasks: [],
        },
      ],
      counts: { total: 20000 },
      pagination: {
        total: 20000,
        totalPages: 400,
        page: 1,
        pageSize: 50,
        hasMore: true,
        nextPage: 2,
      },
    }),
  );
});
afterEach(() => vi.useRealTimers());

it("fetches one workspace page with server filters and preserves revisions", async () => {
  const page = await getMyTaskView("workspace", {
    category: "research",
    horizon: "short",
  });
  expect(page.projects[0].columns[0].tasks[0]).toMatchObject({
    version: 7,
    isSummary: true,
  });
  expect(mocks.page).toHaveBeenCalledTimes(1);
  expect(mocks.page.mock.calls[0][0]).toEqual({
    param: { workspaceId: "workspace" },
    json: { category: "research", horizon: "short", page: 1, limit: 50 },
  });
  expect(mocks.page.mock.calls[0][1].init.signal).toBe(
    mocks.capability.mock.calls[0][1].init.signal,
  );
});
it("fails before listing on unsupported servers", async () => {
  mocks.capability.mockResolvedValue(Response.json({ summaryLists: true }));
  await expect(
    getMyTaskView("workspace", { category: "research" }),
  ).rejects.toThrow("does not support");
  expect(mocks.page).not.toHaveBeenCalled();
});
it("rejects wrong page instead of silently showing old results", async () => {
  await expect(
    getMyTaskView("workspace", { category: "research", page: 2 }),
  ).rejects.toThrow("invalid pagination");
});
it("forwards cancellation and clears deadline", async () => {
  vi.useFakeTimers();
  mocks.page.mockImplementation(
    (_args, options) =>
      new Promise((_resolve, reject) => {
        options.init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  );
  const controller = new AbortController();
  const failure = expect(
    getMyTaskView("workspace", { category: "research" }, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  await failure;
  expect(vi.getTimerCount()).toBe(0);
});
