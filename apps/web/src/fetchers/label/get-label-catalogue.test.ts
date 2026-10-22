import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { page } = vi.hoisted(() => ({ page: vi.fn() }));
vi.mock("@kaneo/libs", () => ({
  client: {
    label: {
      workspace: {
        ":workspaceId": {
          catalogue: { $get: page },
        },
      },
    },
  },
}));

import getLabelCatalogue from "./get-label-catalogue";

beforeEach(() => {
  page.mockReset();
});
afterEach(() => vi.useRealTimers());

function result(total = 20_000) {
  return new Response(
    JSON.stringify({
      items: [
        { id: "one", name: "Bug", color: "gray", isWorkspaceLabel: true },
      ],
      pagination: {
        total,
        page: 1,
        pageSize: 50,
        totalPages: Math.ceil(total / 50),
        hasMore: total > 50,
        nextPage: total > 50 ? 2 : null,
      },
    }),
  );
}

it("makes one bounded request even with twenty thousand groups", async () => {
  page.mockResolvedValue(result());
  const response = await getLabelCatalogue("workspace", { search: "Bug" });
  expect(response.items).toHaveLength(1);
  expect(page).toHaveBeenCalledOnce();
  expect(page.mock.calls[0][0]).toEqual({
    param: { workspaceId: "workspace" },
    query: {
      page: "1",
      limit: "50",
      scope: "groups",
      search: "Bug",
      exact: "false",
    },
  });
});

it("rejects legacy response rather than collecting all assignments", async () => {
  page.mockResolvedValue(new Response(JSON.stringify([])));
  await expect(getLabelCatalogue("workspace")).rejects.toThrow(
    "invalid pagination",
  );
  expect(page).toHaveBeenCalledOnce();
});

it("fails explicitly on unsupported server without fallback", async () => {
  page.mockResolvedValue(new Response("Missing", { status: 404 }));
  await expect(getLabelCatalogue("workspace")).rejects.toThrow(
    "upgrading Kaneo",
  );
  expect(page).toHaveBeenCalledOnce();
});

it("cancels request on deadline and caller cancellation", async () => {
  vi.useFakeTimers();
  page.mockImplementation(
    (_request, { init }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  );
  const timed = getLabelCatalogue("workspace");
  const deadline = expect(timed).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(20_000);
  await deadline;
  const controller = new AbortController();
  const cancelled = getLabelCatalogue("workspace", {}, controller.signal);
  const cancellation = expect(cancelled).rejects.toMatchObject({
    name: "AbortError",
  });
  controller.abort();
  await cancellation;
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects excessive page sizes before dispatch", async () => {
  await expect(getLabelCatalogue("workspace", { limit: 101 })).rejects.toThrow(
    "Invalid",
  );
  expect(page).not.toHaveBeenCalled();
});
