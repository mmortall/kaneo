import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@kaneo/libs", () => ({ client: { search: { $get: mocks.get } } }));

import globalSearch from "./global-search";

beforeEach(() => vi.resetAllMocks());
it.each(["active", "archived", "all"] as const)(
  "forwards explicit %s scope and cancellation",
  async (taskArchive) => {
    mocks.get.mockResolvedValue(Response.json({ results: [], taskArchive }));
    const controller = new AbortController();
    await globalSearch(
      { q: "needle", taskArchive, limit: 20 },
      controller.signal,
    );
    expect(mocks.get).toHaveBeenCalledWith(
      { query: { q: "needle", taskArchive, limit: "20" } },
      { init: { signal: controller.signal } },
    );
  },
);
it("defaults to active tasks", async () => {
  mocks.get.mockResolvedValue(
    Response.json({ results: [], taskArchive: "active" }),
  );
  await globalSearch({ q: "needle" });
  expect(mocks.get.mock.calls[0][0].query.taskArchive).toBe("active");
});
it("rejects legacy or wrong-scope responses instead of mixing archives into active results", async () => {
  mocks.get.mockResolvedValueOnce(Response.json({ results: [{ id: "old" }] }));
  await expect(globalSearch({ q: "needle" })).rejects.toThrow(
    "does not support",
  );
  mocks.get.mockResolvedValueOnce(
    Response.json({ results: [], taskArchive: "all" }),
  );
  await expect(
    globalSearch({ q: "needle", taskArchive: "archived" }),
  ).rejects.toThrow("does not support");
});
