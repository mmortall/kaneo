import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ capability: vi.fn(), page: vi.fn() }));
vi.mock("@kaneo/libs", () => ({
  client: {
    task: {
      agent: {
        capabilities: { $get: mocks.capability },
        view: { ":projectId": { $post: mocks.page } },
      },
    },
  },
}));

import getTaskView from "./get-task-view";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capability.mockResolvedValue(
    new Response(JSON.stringify({ filteredTaskViews: true })),
  );
});
afterEach(() => vi.useRealTimers());

describe("Bounded task view fetcher", () => {
  it.each([4344, 20000])(
    "fetches one summary page for %i matching tasks",
    async (total) => {
      mocks.page.mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              columns: [],
              archivedTasks: [],
              blockedTasks: [],
              plannedTasks: [{ id: "summary", description: null, version: 1 }],
              countsByStatus: { planned: total },
            },
            pagination: {
              total,
              totalPages: Math.ceil(total / 50),
              page: 1,
              pageSize: 50,
              hasMore: true,
              nextPage: 2,
            },
          }),
        ),
      );
      const page = await getTaskView("project", {
        filters: {
          statuses: ["planned", "blocked"],
          text: "description match",
        },
      });
      expect(page.pagination.total).toBe(total);
      expect(page.data.plannedTasks[0].isSummary).toBe(true);
      expect(mocks.page).toHaveBeenCalledTimes(1);
      expect(mocks.page.mock.calls[0][0]).toEqual({
        param: { projectId: "project" },
        json: {
          page: 1,
          limit: 50,
          filters: {
            statuses: ["planned", "blocked"],
            text: "description match",
          },
        },
      });
      expect(mocks.capability.mock.calls[0][1].init.signal).toBe(
        mocks.page.mock.calls[0][1].init.signal,
      );
    },
  );

  it("rejects unsupported server before listing", async () => {
    mocks.capability.mockResolvedValue(
      new Response(JSON.stringify({ summaryLists: true })),
    );
    await expect(getTaskView("project")).rejects.toThrow("does not support");
    expect(mocks.page).not.toHaveBeenCalled();
  });
  it("requires group ID capability before sending long-name group selection", async () => {
    await expect(
      getTaskView("project", { filters: { labelGroupIds: ["group"] } }),
    ).rejects.toThrow("does not support");
    expect(mocks.page).not.toHaveBeenCalled();
  });
  it("requires stable group key capability before dispatch", async () => {
    await expect(
      getTaskView("project", { filters: { labelGroupKeys: ["a".repeat(64)] } }),
    ).rejects.toThrow("does not support");
    expect(mocks.page).not.toHaveBeenCalled();
  });
  it("requires exclusion capability before sending a board query", async () => {
    await expect(
      getTaskView("project", { filters: { excludeStatuses: ["archived"] } }),
    ).rejects.toThrow("does not support");
    expect(mocks.page).not.toHaveBeenCalled();
  });

  it("requires independent scheduled-view capability", async () => {
    await expect(
      getTaskView("project", {
        filters: { scheduledOnly: true },
        sortBy: "scheduleStart",
      }),
    ).rejects.toThrow("does not support");
    expect(mocks.page).not.toHaveBeenCalled();
  });

  it("rejects invalid schedule bounds instead of showing an empty timeline", async () => {
    mocks.capability.mockImplementation(async () =>
      Response.json({ filteredTaskViews: true, scheduledTaskViews: true }),
    );
    mocks.page.mockImplementation(async () =>
      Response.json({
        data: {
          countsByStatus: { planned: 1 },
          scheduleBounds: { start: "invalid", end: "2026-10-10T00:00:00Z" },
        },
        pagination: {
          total: 1,
          totalPages: 1,
          page: 1,
          pageSize: 50,
          hasMore: false,
          nextPage: null,
        },
      }),
    );
    await expect(
      getTaskView("project", { filters: { scheduledOnly: true } }),
    ).rejects.toThrow("bounds");
  });

  it("rejects wrong page metadata instead of showing incompatible results", async () => {
    mocks.page.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { countsByStatus: {} },
          pagination: {
            total: 100,
            totalPages: 2,
            page: 1,
            pageSize: 50,
            hasMore: true,
            nextPage: 2,
          },
        }),
      ),
    );
    await expect(getTaskView("project", { page: 2 })).rejects.toThrow(
      "invalid pagination",
    );
  });

  it("forwards cancellation and clears shared deadline", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    mocks.page.mockImplementation((_args, options) => {
      requestSignal = options.init.signal;
      return new Promise((_resolve, reject) =>
        requestSignal!.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        ),
      );
    });
    const external = new AbortController();
    const promise = getTaskView("project", {}, external.signal);
    const failure = expect(promise).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(1);
    external.abort();
    await failure;
    expect(requestSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts one overall budget even when capability consumed part of it", async () => {
    vi.useFakeTimers();
    mocks.capability.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(
                new Response(JSON.stringify({ filteredTaskViews: true })),
              ),
            15_000,
          ),
        ),
    );
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
    const promise = getTaskView("project");
    const failure = expect(promise).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(mocks.page).toHaveBeenCalledTimes(1);
    expect(mocks.page.mock.calls[0][1].init.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failure;
    expect(vi.getTimerCount()).toBe(0);
  });
});
