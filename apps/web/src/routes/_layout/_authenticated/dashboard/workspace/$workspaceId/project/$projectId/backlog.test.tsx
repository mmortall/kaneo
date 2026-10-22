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
import useBacklogBulkSelectionStore from "@/store/backlog-bulk-selection";
import useProjectStore from "@/store/project";
import { Route } from "./backlog";

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
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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
vi.mock("@/components/common/sort-control", () => ({
  default: ({ onSortChange }: { onSortChange: (value: object) => void }) => (
    <button
      type="button"
      onClick={() => onSortChange({ field: "title", direction: "desc" })}
    >
      Sort by title
    </button>
  ),
}));
vi.mock("@/components/backlog-list-view", () => ({
  default: ({
    project,
    sections,
  }: {
    project: {
      plannedTasks: unknown[];
      archivedTasks: unknown[];
      blockedTasks: unknown[];
    };
    sections: string[];
  }) => (
    <div data-testid="page-rows">
      {sections[0]}:{" "}
      {project.plannedTasks.length +
        project.blockedTasks.length +
        project.archivedTasks.length}{" "}
      rows
    </div>
  ),
}));
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  useProjectStore.setState({ project: undefined });
  useBacklogBulkSelectionStore.getState().clearSelection();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.capability.mockImplementation(async () =>
    Response.json({ filteredTaskViews: true }),
  );
  mocks.page.mockImplementation(
    async ({
      json,
    }: {
      json: { page: number; limit: number; filters: { statuses: string[] } };
    }) => {
      const status = json.filters.statuses[0];
      const count = json.page === 3 ? 21 : 50;
      const tasks = Array.from({ length: count }, (_, i) => ({
        id: `${status}-${json.page}-${i}`,
        title: "Summary",
        status,
        version: 1,
      }));
      return Response.json({
        data: {
          id: "project",
          name: "Project",
          workspaceId: "workspace",
          columns: [],
          countsByStatus: { [status]: 121 },
          plannedTasks: status === "planned" ? tasks : [],
          blockedTasks: status === "blocked" ? tasks : [],
          archivedTasks: status === "archived" ? tasks : [],
        },
        pagination: {
          total: 121,
          totalPages: 3,
          page: json.page,
          pageSize: json.limit,
          hasMore: json.page < 3,
          nextPage: json.page < 3 ? json.page + 1 : null,
        },
      });
    },
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
it("loads only fifty planned summaries initially and does not poll all project pages", async () => {
  view();
  await waitFor(() => {
    const error = screen.queryByRole("alert");
    if (error) throw new Error(error.textContent ?? "Page error");
    expect(screen.queryByText("Page 1 of 3 · 121 tasks")).not.toBeNull();
  });
  await screen.findByText("Page 1 of 3 · 121 tasks");
  expect(screen.getByTestId("page-rows")).toHaveTextContent("planned: 50 rows");
  expect(mocks.page).toHaveBeenCalledOnce();
  expect(mocks.page.mock.calls[0][0].json).toMatchObject({
    page: 1,
    limit: 50,
    filters: { statuses: ["planned"] },
  });
  expect(mocks.legacy).not.toHaveBeenCalled();
  vi.useFakeTimers();
  await vi.advanceTimersByTimeAsync(30_001);
  expect(mocks.page).toHaveBeenCalledOnce();
});
it("navigates explicit pages and clears prior page selection while preserving total", async () => {
  view();
  await screen.findByText("Page 1 of 3 · 121 tasks");
  useBacklogBulkSelectionStore.getState().selectTask("planned-1-0");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Page 2 of 3 · 121 tasks");
  expect(useBacklogBulkSelectionStore.getState().getSelectedCount()).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Page 3 of 3 · 121 tasks");
  expect(screen.getByTestId("page-rows")).toHaveTextContent("21 rows");
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  expect(mocks.page.mock.calls.map((call) => call[0].json.page)).toEqual([
    1, 2, 3,
  ]);
});
it("archive and blocked data are fetched only when selected and start at page one", async () => {
  view();
  await screen.findByText("Page 1 of 3 · 121 tasks");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Page 2 of 3 · 121 tasks");
  fireEvent.click(
    screen.getByRole("button", { name: "tasks:backlog.sections.archived" }),
  );
  await screen.findByText("Page 1 of 3 · 121 tasks");
  expect(screen.getByTestId("page-rows")).toHaveTextContent(
    "archived: 50 rows",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "tasks:backlog.sections.blocked" }),
  );
  await waitFor(() =>
    expect(screen.getByTestId("page-rows")).toHaveTextContent(
      "blocked: 50 rows",
    ),
  );
  expect(
    mocks.page.mock.calls.map((call) => [
      call[0].json.page,
      call[0].json.filters.statuses,
    ]),
  ).toEqual([
    [1, ["planned"]],
    [2, ["planned"]],
    [1, ["archived"]],
    [1, ["blocked"]],
  ]);
});
it("sort resets page and runs on server before selecting rows", async () => {
  view();
  await screen.findByText("Page 1 of 3 · 121 tasks");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Page 2 of 3 · 121 tasks");
  fireEvent.click(screen.getByRole("button", { name: "Sort by title" }));
  await screen.findByText("Page 1 of 3 · 121 tasks");
  expect(mocks.page.mock.calls.at(-1)?.[0].json).toMatchObject({
    page: 1,
    sortBy: "title",
    sortOrder: "desc",
  });
});
it("old server is rejected visibly without full list fallback", async () => {
  mocks.capability.mockImplementation(async () => Response.json({}));
  view();
  await screen.findByRole("alert");
  expect(mocks.page).not.toHaveBeenCalled();
  expect(mocks.legacy).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
});

it("refresh after task removal clamps missing page and invalidates cached earlier counts", async () => {
  view();
  await screen.findByText("Page 1 of 3 · 121 tasks");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Page 2 of 3 · 121 tasks");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Page 3 of 3 · 121 tasks");
  mocks.page.mockImplementation(
    async ({ json }: { json: { page: number; limit: number } }) =>
      Response.json({
        data: {
          id: "project",
          name: "Project",
          workspaceId: "workspace",
          columns: [],
          countsByStatus: { planned: 10 },
          plannedTasks:
            json.page === 1
              ? Array.from({ length: 10 }, (_, i) => ({
                  id: `remaining-${i}`,
                  version: 2,
                }))
              : [],
          blockedTasks: [],
          archivedTasks: [],
        },
        pagination: {
          total: 10,
          totalPages: 1,
          page: json.page,
          pageSize: json.limit,
          hasMore: false,
          nextPage: null,
        },
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Page 1 of 1 · 10 tasks");
  expect(screen.getByTestId("page-rows")).toHaveTextContent("10 rows");
  expect(mocks.page.mock.calls.map((call) => call[0].json.page)).toEqual([
    1, 2, 3, 3, 1,
  ]);
});
