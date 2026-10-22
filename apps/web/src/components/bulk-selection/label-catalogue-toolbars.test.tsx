import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import useBacklogBulkSelectionStore from "@/store/backlog-bulk-selection";
import useBulkSelectionStore from "@/store/bulk-selection";
import BacklogBulkToolbar from "./backlog-bulk-toolbar";
import BulkToolbar from "./bulk-toolbar";

const mocks = vi.hoisted(() => ({
  page: vi.fn(),
  legacy: vi.fn(),
  add: vi.fn(),
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
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
  initReactI18next: { type: "3rdParty", init: vi.fn() },
}));
vi.mock("@/hooks/queries/workspace/use-active-workspace", () => ({
  default: () => ({ data: { id: "workspace" } }),
}));
vi.mock(
  "@/hooks/queries/workspace-users/use-get-active-workspace-users",
  () => ({ useGetActiveWorkspaceUsers: () => ({ data: { members: [] } }) }),
);
vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({
    canManageTasks: () => true,
    canAssignTasks: () => true,
  }),
}));
vi.mock("@/hooks/mutations/task/use-bulk-operations", () => ({
  useBulkOperations: () => ({
    bulkAddLabel: mocks.add,
    bulkMoveToBacklog: vi.fn(),
    bulkMoveToBoard: vi.fn(),
    bulkDelete: vi.fn(),
    bulkArchive: vi.fn(),
    bulkChangeStatus: vi.fn(),
    bulkAssign: vi.fn(),
    bulkPriority: vi.fn(),
    bulkDueDate: vi.fn(),
  }),
}));

beforeEach(() => {
  mocks.page.mockReset();
  mocks.legacy.mockReset();
  mocks.add.mockReset();
  mocks.add.mockResolvedValue(undefined);
  useBulkSelectionStore.getState().clearSelection();
  useBacklogBulkSelectionStore.getState().clearSelection();
  mocks.page.mockImplementation(({ query }) => {
    const rows = Array.from({ length: 53 }, (_, i) => ({
      id: `label-${i}`,
      name: `Label${String(i).padStart(3, "0")}`,
      color: "gray",
      isWorkspaceLabel: true,
    })).filter((row) =>
      row.name.toLowerCase().includes(query.search.toLowerCase()),
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

for (const [name, Component, store] of [
  ["board", BulkToolbar, useBulkSelectionStore],
  ["backlog", BacklogBulkToolbar, useBacklogBulkSelectionStore],
] as const) {
  function mount() {
    store.getState().selectTask("reviewed-task");
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <Component />
      </QueryClientProvider>,
    );
  }

  it(`${name} loads only open catalogue and assigns label from later page`, async () => {
    mount();
    expect(mocks.page).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "tasks:bulk.actions" }));
    await screen.findByText("Label049");
    expect(screen.queryByText("Label050")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Label050");
    expect(screen.queryByText("Label000")).toBeNull();
    fireEvent.click(screen.getByText("Label050"));
    await waitFor(() =>
      expect(mocks.add).toHaveBeenCalledWith({
        taskIds: ["reviewed-task"],
        labelId: "label-50",
      }),
    );
    expect(mocks.legacy).not.toHaveBeenCalled();
  });

  it(`${name} searches labels on server with bounded first page`, async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "tasks:bulk.actions" }));
    await screen.findByText("Label000");
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "Label052" },
    });
    await screen.findByText("Label052");
    expect(mocks.page.mock.calls.at(-1)?.[0].query).toMatchObject({
      page: "1",
      search: "Label052",
      limit: "50",
    });
    expect(mocks.legacy).not.toHaveBeenCalled();
  });

  it(`${name} keeps other actions available on catalogue error and permits retry`, async () => {
    mocks.page.mockRejectedValueOnce(new Error("Labels unavailable"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "tasks:bulk.actions" }));
    await screen.findByText("Labels unavailable");
    expect(screen.getByText("tasks:bulk.delete")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Label000");
    expect(mocks.legacy).not.toHaveBeenCalled();
  });
}
