import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CreateTaskModal from "./create-task-modal";

const mocks = vi.hoisted(() => ({
  page: vi.fn(),
  legacy: vi.fn(),
  createLabel: vi.fn(),
  createTask: vi.fn(),
}));
vi.mock("@kaneo/libs", () => ({
  client: {
    label: {
      workspace: {
        ":workspaceId": {
          $get: mocks.legacy,
          catalogue: { $get: mocks.page },
        },
      },
    },
  },
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: () => ({
    pathname: "/dashboard/workspace/workspace/project/project/board",
  }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
  initReactI18next: { type: "3rdParty", init: vi.fn() },
}));
vi.mock("@/components/task/task-description-editor", () => ({
  default: () => null,
}));
vi.mock("@/hooks/queries/workspace/use-active-workspace", () => ({
  default: () => ({ data: { id: "workspace" } }),
}));
vi.mock(
  "@/hooks/queries/workspace-users/use-get-active-workspace-users",
  () => ({ useGetActiveWorkspaceUsers: () => ({ data: { members: [] } }) }),
);
vi.mock("@/hooks/queries/project/use-get-projects", () => ({
  default: () => ({
    data: [{ id: "project", name: "Owned project", slug: "owned" }],
  }),
}));
vi.mock("@/store/project", () => ({
  default: () => ({ project: null, setProject: vi.fn() }),
}));
vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({
    canCreateTasks: () => true,
    canManageLabels: () => true,
  }),
}));
vi.mock("@/hooks/mutations/label/use-create-label", () => ({
  default: () => ({ mutateAsync: mocks.createLabel }),
}));
vi.mock("@/hooks/mutations/task/use-create-task", () => ({
  default: () => ({ mutateAsync: mocks.createTask }),
}));
vi.mock("@/hooks/mutations/task/use-update-task", () => ({
  useUpdateTask: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/mutations/task/use-delete-task", () => ({
  useDeleteTask: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  mocks.page.mockReset();
  mocks.legacy.mockReset();
  mocks.createLabel.mockReset();
  mocks.createTask.mockReset();
  mocks.createTask.mockImplementation(async (input) => ({
    ...input,
    id: "saved",
    version: 1,
    createdAt: new Date().toISOString(),
  }));
  mocks.createLabel.mockImplementation(async (input) => ({
    ...input,
    id: "saved-label",
  }));
  mocks.page.mockImplementation(({ query }) => {
    const all = Array.from({ length: 51 }, (_, i) => ({
      id: `label-${i}`,
      name: `Label${String(i).padStart(3, "0")}`,
      color: i === 50 ? "red" : "gray",
      isWorkspaceLabel: true,
    }));
    const rows = all.filter((row) =>
      query.exact === "true"
        ? row.name.toLowerCase() === query.search.toLowerCase()
        : row.name.toLowerCase().includes(query.search.toLowerCase()),
    );
    const page = Number(query.page);
    const limit = Number(query.limit);
    const total = rows.length;
    const hasMore = page * limit < total;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          items: rows.slice((page - 1) * limit, page * limit),
          pagination: {
            page,
            pageSize: limit,
            total,
            totalPages: Math.ceil(total / limit),
            hasMore,
            nextPage: hasMore ? page + 1 : null,
          },
        }),
      ),
    );
  });
});
afterEach(cleanup);

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <CreateTaskModal open onClose={vi.fn()} projectId="project" />
    </QueryClientProvider>,
  );
}

it("retains labels from different pages and submits their reviewed name and color", async () => {
  mount();
  expect(mocks.page).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("common:modals.createTask.labels"));
  await screen.findByText("Label000");
  fireEvent.click(screen.getByText("Label000"));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Label050");
  fireEvent.click(screen.getByText("Label050"));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search labels" }), {
    target: { value: "Label010" },
  });
  await screen.findByText("Label010");
  expect(screen.getByText("Label000")).toBeTruthy();
  expect(screen.getByText("Label050")).toBeTruthy();
  fireEvent.change(
    screen.getByPlaceholderText(
      "common:modals.createTask.taskTitlePlaceholder",
    ),
    { target: { value: "Owned task" } },
  );
  fireEvent.submit(document.querySelector("form")!);
  await waitFor(() => expect(mocks.createLabel).toHaveBeenCalledTimes(2));
  expect(mocks.createLabel).toHaveBeenCalledWith({
    name: "Label000",
    color: "gray",
    taskId: "saved",
    workspaceId: "workspace",
  });
  expect(mocks.createLabel).toHaveBeenCalledWith({
    name: "Label050",
    color: "red",
    taskId: "saved",
    workspaceId: "workspace",
  });
  expect(mocks.legacy).not.toHaveBeenCalled();
});

it("does not offer duplicate creation while exact lookup is unavailable", async () => {
  const normal = mocks.page.getMockImplementation()!;
  mocks.page.mockImplementation((request, options) =>
    request.query.exact === "true"
      ? Promise.reject(new Error("Name check unavailable"))
      : normal(request, options),
  );
  mount();
  fireEvent.click(screen.getByText("common:modals.createTask.labels"));
  await screen.findByText("Label000");
  fireEvent.change(screen.getByRole("searchbox", { name: "Search labels" }), {
    target: { value: "New label" },
  });
  await screen.findByText("Name check unavailable");
  expect(screen.queryByText("common:modals.createTask.createLabel")).toBeNull();
  expect(mocks.createLabel).not.toHaveBeenCalled();
});
