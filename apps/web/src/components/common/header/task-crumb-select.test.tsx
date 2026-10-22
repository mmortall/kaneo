import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TaskCrumbSelect from "./task-crumb-select";

const mocks = vi.hoisted(() => ({
  view: vi.fn(),
  legacy: vi.fn(),
  select: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/queries/task/use-get-task-view", () => ({
  useGetTaskView: (...args: unknown[]) => mocks.view(...args),
}));
vi.mock("@/hooks/queries/task/use-get-tasks", () => ({
  useGetTasks: () => mocks.legacy(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.legacy.mockImplementation(() => {
    throw new Error("Selector must not collect whole project");
  });
  mocks.view.mockImplementation((projectId, options) => {
    const page = options.page ?? 1;
    const title = options.filters?.text
      ? "Different title"
      : page === 1
        ? "First page"
        : "Later page";
    return {
      data: projectId
        ? {
            data: {
              columns: [
                { tasks: [{ id: `task-${page}`, title, number: page }] },
              ],
              plannedTasks: [],
              blockedTasks: [],
              archivedTasks: [],
            },
            pagination: {
              total: 20_000,
              totalPages: 400,
              hasMore: page < 400,
              nextPage: page + 1,
            },
          }
        : undefined,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    };
  });
});
afterEach(cleanup);

it("does not request project tasks while selector is closed", () => {
  render(
    <TaskCrumbSelect
      projectId="project"
      taskId="task-1"
      taskLabel="Current"
      onSelectTask={mocks.select}
    />,
  );
  expect(mocks.legacy).not.toHaveBeenCalled();
  expect(mocks.view).toHaveBeenLastCalledWith(
    "",
    expect.objectContaining({ page: 1 }),
  );
});

it("loads one page on open and loads later pages only after explicit navigation", async () => {
  render(
    <TaskCrumbSelect
      projectId="project"
      taskId="task-1"
      taskLabel="Current"
      onSelectTask={mocks.select}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Current" }));
  expect(
    await screen.findByRole("option", { name: /First page/ }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(mocks.view).toHaveBeenLastCalledWith(
    "project",
    expect.objectContaining({ page: 1 }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "common:pagination.nextPage" }),
  );
  const later = await screen.findByRole("option", { name: /Later page/ });
  expect(mocks.view).toHaveBeenLastCalledWith(
    "project",
    expect.objectContaining({ page: 2 }),
  );
  fireEvent.click(later);
  expect(mocks.select).toHaveBeenCalledWith("task-2");
  expect(mocks.legacy).not.toHaveBeenCalled();
});

it("searches before pagination without locally hiding description-only matches", async () => {
  render(
    <TaskCrumbSelect
      projectId="project"
      taskId="selected"
      taskLabel="Current"
      onSelectTask={mocks.select}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Current" }));
  const input = await screen.findByRole("combobox");
  fireEvent.change(input, { target: { value: "hidden-prose" } });
  await waitFor(
    () =>
      expect(mocks.view).toHaveBeenLastCalledWith(
        "project",
        expect.objectContaining({ page: 1, filters: { text: "hidden-prose" } }),
      ),
    { timeout: 1500 },
  );
  expect(
    await screen.findByRole("option", { name: /Different title/ }),
  ).toBeVisible();
});
