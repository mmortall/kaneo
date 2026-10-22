import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import exportTasks from "./export-tasks";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@kaneo/libs", () => ({
  client: { task: { agent: { export: { ":projectId": { $get: get } } } } },
}));
const project = { name: "Export fixture", exportedAt: "2026-10-08" };
const page = (tasks: unknown[], nextCursor: string | null) =>
  new Response(
    JSON.stringify({ project, tasks, pagination: { limit: 100, nextCursor } }),
  );

describe("Paged task export", () => {
  beforeEach(() => get.mockReset());
  afterEach(() => vi.useRealTimers());
  it("assembles every page and preserves first project metadata and task fields", async () => {
    const first = {
      title: "First",
      description: "Full text",
      labels: [{ name: "Label" }],
      strategyHorizons: ["short"],
    };
    get
      .mockResolvedValueOnce(page([first], "cursor-1"))
      .mockResolvedValueOnce(
        page([{ title: "Last", status: "archived" }], null),
      );
    await expect(exportTasks("project")).resolves.toEqual({
      project,
      tasks: [first, { title: "Last", status: "archived" }],
    });
    expect(get.mock.calls[1][0]).toEqual({
      param: { projectId: "project" },
      query: { limit: "100", cursor: "cursor-1" },
    });
    expect(get.mock.calls[0][1].init.signal).toBe(
      get.mock.calls[1][1].init.signal,
    );
  });
  it("does not return incomplete export when later page fails", async () => {
    get
      .mockResolvedValueOnce(page([{ title: "First" }], "cursor-1"))
      .mockResolvedValueOnce(new Response("Forbidden", { status: 403 }));
    await expect(exportTasks("project")).rejects.toThrow("Forbidden");
  });
  it("rejects repeated cursors", async () => {
    get.mockImplementation(() => Promise.resolve(page([], "repeat")));
    await expect(exportTasks("project")).rejects.toThrow("repeated cursor");
    expect(get).toHaveBeenCalledTimes(2);
  });
  it("rejects missing pagination rather than returning partial data", async () => {
    get.mockResolvedValue(new Response(JSON.stringify({ project, tasks: [] })));
    await expect(exportTasks("project")).rejects.toThrow("unavailable");
  });
  it("aborts pending page at shared 300-second deadline", async () => {
    vi.useFakeTimers();
    get.mockResolvedValueOnce(page([], "cursor-1")).mockImplementationOnce(
      (_args, options) =>
        new Promise((_resolve, reject) => {
          options.init.signal.addEventListener(
            "abort",
            () => reject(new Error("Export aborted")),
            { once: true },
          );
        }),
    );
    const result = expect(exportTasks("project")).rejects.toThrow(
      "Export aborted",
    );
    await vi.advanceTimersByTimeAsync(300_000);
    await result;
    expect(get.mock.calls[1][1].init.signal.aborted).toBe(true);
  });
});
