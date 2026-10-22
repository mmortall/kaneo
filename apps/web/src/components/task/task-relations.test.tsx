import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TaskRelations from "./task-relations";

const mocks = vi.hoisted(() => ({
  view: vi.fn(),
  legacy: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/queries/task/use-get-task-view", () => ({
  useGetTaskView: (...args: unknown[]) => mocks.view(...args),
}));
vi.mock("@/hooks/queries/task/use-get-tasks", () => ({
  useGetTasks: () => mocks.legacy(),
}));
vi.mock("@/hooks/queries/column/use-get-columns", () => ({
  useGetColumns: () => ({
    data: [{ id: "column-row", slug: "done", isFinal: true }],
  }),
}));
vi.mock("@/hooks/queries/project/use-get-project", () => ({
  default: () => ({ data: { slug: "PROJ" } }),
}));
vi.mock("@/hooks/queries/task-relation/use-get-task-relations", () => ({
  default: () => ({ data: [] }),
}));
vi.mock("@/hooks/queries/workspace/use-active-workspace", () => ({
  default: () => ({ data: { id: "workspace" } }),
}));
vi.mock(
  "@/hooks/queries/workspace-users/use-get-active-workspace-users",
  () => ({ useGetActiveWorkspaceUsers: () => ({ data: { members: [] } }) }),
);
vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({ canManageTasks: () => true }),
}));
vi.mock("@/hooks/mutations/task-relation/use-create-task-relation", () => ({
  default: () => ({ mutateAsync: mocks.create, isPending: false }),
}));
vi.mock("@/hooks/mutations/task-relation/use-delete-task-relation", () => ({
  default: () => ({ mutate: vi.fn() }),
}));
vi.mock("./subtask-assignee-popover", () => ({ default: () => null }));
vi.mock("./subtask-status-popover", () => ({ default: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({});
  mocks.legacy.mockImplementation(() => {
    throw new Error("Must not collect all project tasks");
  });
  mocks.view.mockImplementation((projectId, options) => {
    const page = options.page;
    const task = {
      id: `candidate-${page}`,
      number: page,
      status: "planned",
      title: options.filters.text ? "Different title" : `Page ${page}`,
    };
    return {
      data: projectId
        ? {
            data: {
              columns: [],
              plannedTasks: [task],
              blockedTasks: [],
              archivedTasks: [],
            },
            pagination: { total: 20_000, totalPages: 400, hasMore: page < 400 },
          }
        : undefined,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    };
  });
});
afterEach(cleanup);

it("keeps closed candidate queries disabled and never uses whole-project collector", () => {
  render(
    <TaskRelations
      taskId="current"
      projectId="project"
      workspaceId="workspace"
    />,
  );
  expect(mocks.view).toHaveBeenLastCalledWith(
    "",
    expect.objectContaining({ page: 1 }),
  );
  expect(mocks.legacy).not.toHaveBeenCalled();
});

it("links a planned task from an explicitly loaded later page", async () => {
  render(
    <TaskRelations
      taskId="current"
      projectId="project"
      workspaceId="workspace"
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "tasks:relations.searchPlaceholder" }),
  );
  expect(await screen.findByRole("option", { name: /Page 1/ })).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "common:pagination.nextPage" }),
  );
  fireEvent.click(await screen.findByRole("option", { name: /Page 2/ }));
  await waitFor(() =>
    expect(mocks.create).toHaveBeenCalledWith({
      sourceTaskId: "current",
      targetTaskId: "candidate-2",
      relationType: "related",
    }),
  );
  expect(mocks.legacy).not.toHaveBeenCalled();
});

it("resets search pagination and retains description-only server matches", async () => {
  render(
    <TaskRelations
      taskId="current"
      projectId="project"
      workspaceId="workspace"
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "tasks:relations.searchPlaceholder" }),
  );
  await screen.findByRole("combobox");
  fireEvent.click(
    screen.getByRole("button", { name: "common:pagination.nextPage" }),
  );
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "hidden-prose" },
  });
  await waitFor(() =>
    expect(mocks.view).toHaveBeenLastCalledWith("project", {
      page: 1,
      filters: { text: "hidden-prose" },
    }),
  );
  expect(
    await screen.findByRole("option", { name: /Different title/ }),
  ).toBeVisible();
});
it("links the highlighted task with keyboard selection", async () => {
  render(
    <TaskRelations
      taskId="current"
      projectId="project"
      workspaceId="workspace"
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "tasks:relations.searchPlaceholder" }),
  );
  const input = await screen.findByRole("combobox");
  const option = await screen.findByRole("option", { name: /Page 1/ });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  await waitFor(() =>
    expect(input).toHaveAttribute("aria-activedescendant", option.id),
  );
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() =>
    expect(mocks.create).toHaveBeenCalledWith({
      sourceTaskId: "current",
      targetTaskId: "candidate-1",
      relationType: "related",
    }),
  );
});
