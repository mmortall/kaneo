import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import useBulkSelectionStore from "@/store/bulk-selection";
import useProjectStore from "@/store/project";
import { Route } from "./board";

const mocks = vi.hoisted(() => ({
  capability: vi.fn(),
  page: vi.fn(),
  legacy: vi.fn(),
  labels: [],
}));
vi.mock("@kaneo/libs", () => ({
  client: {
    task: {
      tasks: { ":projectId": { $get: mocks.legacy } },
      agent: {
        capabilities: { $get: mocks.capability },
        view: { ":projectId": { $post: mocks.page } },
      },
    },
  },
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: object) => ({
    options,
    useParams: () => ({ projectId: "project", workspaceId: "workspace" }),
    useSearch: () => ({}),
  }),
  useNavigate: () => vi.fn(),
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/common/project-layout", () => ({
  default: ({
    children,
    headerActions,
  }: {
    children: ReactNode;
    headerActions: ReactNode;
  }) => (
    <div>
      {headerActions}
      {children}
    </div>
  ),
}));
vi.mock("@/components/page-title", () => ({ default: () => null }));
vi.mock("@/components/shared/modals/create-task-modal", () => ({
  default: () => null,
}));
vi.mock("@/components/shared/modals/task-group-modal", () => ({
  TaskGroupModal: () => null,
}));
vi.mock("@/components/task/task-details-sheet", () => ({
  default: () => null,
}));
vi.mock("@/hooks/queries/label/use-get-labels-by-workspace", () => ({
  default: () => ({ data: mocks.labels }),
}));
vi.mock(
  "@/hooks/queries/workspace-users/use-get-active-workspace-users",
  () => ({ useGetActiveWorkspaceUsers: () => ({ data: { members: [] } }) }),
);
vi.mock("@/hooks/use-keyboard-shortcuts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-keyboard-shortcuts")>()),
  useRegisterShortcuts: vi.fn(),
}));
vi.mock("@/components/board/board-toolbar", () => ({
  default: ({
    onSortChange,
    updateFilter,
    setViewMode,
  }: {
    onSortChange: (value: object) => void;
    updateFilter: (key: string, value: string[]) => void;
    setViewMode: (value: string) => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() => onSortChange({ field: "title", direction: "desc" })}
      >
        Sort by title
      </button>
      <button type="button" onClick={() => updateFilter("priority", ["high"])}>
        High priority
      </button>
      <button type="button" onClick={() => setViewMode("list")}>
        List view
      </button>
    </div>
  ),
}));
vi.mock("@/components/kanban-board", () => ({
  default: ({ project }: { project: { columns: { tasks: unknown[] }[] } }) => (
    <div data-testid="board-rows">
      {project.columns.flatMap((column) => column.tasks).length} rows
    </div>
  ),
}));
vi.mock("@/components/list-view", () => ({
  default: ({ project }: { project: { columns: { tasks: unknown[] }[] } }) => (
    <div data-testid="list-rows">
      {project.columns.flatMap((column) => column.tasks).length} rows
    </div>
  ),
}));

let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  useProjectStore.setState({ project: undefined });
  useBulkSelectionStore.getState().clearSelection();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.capability.mockImplementation(async () =>
    Response.json({ filteredTaskViews: true, taskViewExclusions: true }),
  );
  mocks.page.mockImplementation(
    async ({ json }: { json: { page: number; limit: number } }) =>
      Response.json({
        data: {
          id: "project",
          name: "Project",
          workspaceId: "workspace",
          columns: [
            {
              id: "to-do",
              name: "To Do",
              tasks: Array.from(
                { length: json.page === 4 ? 13 : 50 },
                (_, i) => ({
                  id: `page-${json.page}-${i}`,
                  status: "to-do",
                  version: 1,
                }),
              ),
            },
            { id: "done", name: "Done", isFinal: true, tasks: [] },
          ],
          countsByStatus: { "to-do": 121, done: 42 },
          archivedTasks: [],
          plannedTasks: [],
          blockedTasks: [],
        },
        pagination: {
          total: 163,
          totalPages: 4,
          page: json.page,
          pageSize: json.limit,
          hasMore: json.page < 4,
          nextPage: json.page < 4 ? json.page + 1 : null,
        },
      }),
  );
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
});
function view() {
  const Component = Route.options.component as ComponentType;
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
}
it("requests one bounded active page without a legacy collector or periodic polling", async () => {
  view();
  await screen.findByText("Page 1 of 4 - 163 tasks");
  expect(mocks.page).toHaveBeenCalledOnce();
  expect(mocks.page.mock.calls[0][0].json).toMatchObject({
    page: 1,
    limit: 50,
    filters: { excludeStatuses: ["archived", "planned", "blocked"] },
  });
  expect(mocks.legacy).not.toHaveBeenCalled();
  vi.useFakeTimers();
  await vi.advanceTimersByTimeAsync(30_001);
  expect(mocks.page).toHaveBeenCalledOnce();
});
it("clears page selection and resets pagination for filters and sorting", async () => {
  view();
  await screen.findByText("Page 1 of 4 - 163 tasks");
  useBulkSelectionStore.getState().selectTask("page-1-0");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Page 2 of 4 - 163 tasks");
  expect(useBulkSelectionStore.getState().selectedTaskIds.size).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "High priority" }));
  await waitFor(() =>
    expect(mocks.page.mock.lastCall?.[0].json).toMatchObject({
      page: 1,
      filters: { priorities: ["high"] },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Page 2 of 4 - 163 tasks");
  fireEvent.click(screen.getByRole("button", { name: "Sort by title" }));
  await waitFor(() =>
    expect(mocks.page.mock.lastCall?.[0].json).toMatchObject({
      page: 1,
      sortBy: "title",
      sortOrder: "desc",
    }),
  );
});
it("switches to list without collecting more pages", async () => {
  view();
  await screen.findByText("Page 1 of 4 - 163 tasks");
  fireEvent.click(screen.getByRole("button", { name: "List view" }));
  expect(screen.getByTestId("list-rows")).toHaveTextContent("50 rows");
  expect(mocks.page).toHaveBeenCalledOnce();
});
it("fails closed on old server without status exclusions", async () => {
  mocks.capability.mockImplementation(async () =>
    Response.json({ filteredTaskViews: true }),
  );
  view();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "does not support",
  );
  expect(mocks.page).not.toHaveBeenCalled();
});
