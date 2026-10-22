import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@kaneo/libs", () => ({
  client: { task: { tasks: { ":projectId": { $get: mocks.get } } } },
}));

import getTasks from "./get-tasks";

function page(index: number, totalPages = 2) {
  return new Response(
    JSON.stringify({
      pagination: { totalPages },
      data: {
        id: "project",
        columns: [
          { id: "to-do", tasks: [{ id: `todo-${index}`, version: 1 }] },
          { id: "done", tasks: [{ id: `done-${index}`, version: 1 }] },
        ],
        archivedTasks: [{ id: `archive-${index}` }],
        plannedTasks: [{ id: `planned-${index}` }],
        blockedTasks: [{ id: `blocked-${index}` }],
      },
    }),
  );
}
describe("Complete board pagination", () => {
  beforeEach(() => mocks.get.mockReset());
  it("keeps every column and virtual status while requesting bounded pages", async () => {
    mocks.get.mockResolvedValueOnce(page(1)).mockResolvedValueOnce(page(2));
    const board = await getTasks("project", { assigneeId: "user" });
    expect(board.columns[0].tasks.map((t) => t.id)).toEqual([
      "todo-1",
      "todo-2",
    ]);
    expect(board.columns[1].tasks.map((t) => t.id)).toEqual([
      "done-1",
      "done-2",
    ]);
    expect(board.archivedTasks.map((t) => t.id)).toEqual([
      "archive-1",
      "archive-2",
    ]);
    expect(board.plannedTasks.map((t) => t.id)).toEqual([
      "planned-1",
      "planned-2",
    ]);
    expect(board.blockedTasks.map((t) => t.id)).toEqual([
      "blocked-1",
      "blocked-2",
    ]);
    expect(mocks.get.mock.calls.map((c) => c[0].query)).toEqual(
      [1, 2].map((page) => ({
        assigneeId: "user",
        page: String(page),
        limit: "100",
        sortBy: "number",
        sortOrder: "asc",
      })),
    );
  });
  it("fails rather than presenting incomplete board after page failure", async () => {
    mocks.get
      .mockResolvedValueOnce(page(1))
      .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }));
    await expect(getTasks("project")).rejects.toThrow("Unavailable");
  });
});
