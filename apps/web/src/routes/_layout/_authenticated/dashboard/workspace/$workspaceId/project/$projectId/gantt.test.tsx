import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Route } from "./gantt";

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
vi.mock("@/components/gantt/gantt-task-bar", () => ({
  GanttTaskBar: ({
    task,
    timeline,
  }: {
    task: { title: string };
    timeline: { days: Date[] };
  }) => (
    <span data-testid="task-bar" data-days={timeline.days.length}>
      {task.title}
    </span>
  ),
}));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/lib/i18n/domain", () => ({
  getStatusLabel: (value: string) => value,
}));
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.capability.mockImplementation(async () =>
    Response.json({
      filteredTaskViews: true,
      taskViewExclusions: true,
      scheduledTaskViews: true,
    }),
  );
  mocks.page.mockImplementation(
    async ({
      json,
    }: {
      json: { page: number; limit: number; filters: { text?: string } };
    }) => {
      const searched = !!json.filters.text;
      return Response.json({
        data: {
          id: "project",
          name: "Project",
          slug: "gantt",
          workspaceId: "workspace",
          countsByStatus: { "to-do": searched ? 1 : 95 },
          scheduleBounds: {
            start: "2026-10-01T00:00:00Z",
            end: "2026-12-01T00:00:00Z",
          },
          columns: [
            {
              id: "to-do",
              name: "To Do",
              tasks: Array.from(
                { length: searched ? 1 : json.page === 1 ? 50 : 45 },
                (_, i) => ({
                  id: `task-${json.page}-${i}`,
                  projectId: "project",
                  version: 7,
                  title: searched
                    ? "Late search match"
                    : `Page ${json.page} task ${i}`,
                  status: "to-do",
                  number: i + 1,
                  startDate: "2026-10-10T00:00:00Z",
                  dueDate: "2026-10-12T00:00:00Z",
                }),
              ),
            },
          ],
          plannedTasks: [],
          blockedTasks: [],
          archivedTasks: [],
        },
        pagination: {
          total: searched ? 1 : 95,
          totalPages: searched ? 1 : 2,
          page: json.page,
          pageSize: json.limit,
          hasMore: !searched && json.page === 1,
          nextPage: !searched && json.page === 1 ? 2 : null,
        },
      });
    },
  );
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function view() {
  const Component = Route.options.component as ComponentType;
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
}
it("fetches one scheduled page and keeps full-set timeline bounds across navigation without polling", async () => {
  view();
  await screen.findByText("Page 1 of 2 - 95 scheduled tasks");
  expect(screen.getAllByTestId("task-bar")).toHaveLength(50);
  const days = screen.getAllByTestId("task-bar")[0].getAttribute("data-days");
  expect(mocks.page.mock.calls[0][0].json).toMatchObject({
    page: 1,
    limit: 50,
    sortBy: "scheduleStart",
    filters: {
      scheduledOnly: true,
      searchStatus: true,
      excludeStatuses: ["archived"],
    },
  });
  expect(mocks.page).toHaveBeenCalledOnce();
  expect(mocks.legacy).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Page 2 of 2 - 95 scheduled tasks");
  expect(screen.getAllByTestId("task-bar")).toHaveLength(45);
  expect(screen.getAllByTestId("task-bar")[0].getAttribute("data-days")).toBe(
    days,
  );
  vi.useFakeTimers();
  await vi.advanceTimersByTimeAsync(30001);
  expect(mocks.page).toHaveBeenCalledTimes(2);
});
it("searches complete scheduled set on server and resets page", async () => {
  view();
  await screen.findByText("Page 1 of 2 - 95 scheduled tasks");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Page 2 of 2 - 95 scheduled tasks");
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "blocked" },
  });
  await screen.findByText("Page 1 of 1 - 1 scheduled tasks");
  expect(mocks.page.mock.lastCall?.[0].json).toMatchObject({
    page: 1,
    filters: { text: "blocked", searchStatus: true },
  });
  expect(screen.getAllByTestId("task-bar")).toHaveLength(1);
});
it("fails visibly before collecting tasks from old server", async () => {
  mocks.capability.mockImplementation(async () =>
    Response.json({ filteredTaskViews: true, taskViewExclusions: true }),
  );
  view();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "does not support",
  );
  expect(mocks.page).not.toHaveBeenCalled();
});
