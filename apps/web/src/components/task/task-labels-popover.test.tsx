import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import type Task from "@/types/task";
import TaskLabelsPopover from "./task-labels-popover";

const mocks = vi.hoisted(() => ({
  page: vi.fn(),
  legacy: vi.fn(),
  create: vi.fn(),
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
vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({
    canManageTasks: () => true,
    canManageLabels: () => true,
  }),
}));
vi.mock("@/hooks/queries/label/use-get-labels-by-task", () => ({
  default: () => ({ data: [] }),
}));
vi.mock("@/hooks/mutations/label/use-create-label", () => ({
  default: () => ({ mutateAsync: mocks.create }),
}));
vi.mock("@/hooks/mutations/label/use-delete-label", () => ({
  default: () => ({ mutateAsync: vi.fn() }),
}));

beforeEach(() => {
  mocks.page.mockReset();
  mocks.legacy.mockReset();
  mocks.create.mockReset();
  mocks.page.mockImplementation(({ query }) => {
    const all = Array.from({ length: 51 }, (_, i) => ({
      id: `label-${i}`,
      name: `Label${String(i).padStart(3, "0")}`,
      color: "gray",
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
  const task = { id: "task", projectId: "project", version: 1 } as Task;
  render(
    <QueryClientProvider client={client}>
      <TaskLabelsPopover task={task} workspaceId="workspace">
        <Button>Edit labels</Button>
      </TaskLabelsPopover>
    </QueryClientProvider>,
  );
}

it("does not load closed catalogue and exposes next page when opened", async () => {
  mount();
  expect(mocks.page).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Edit labels" }));
  await screen.findByText("Label049");
  expect(screen.queryByText("Label050")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Label050");
  expect(screen.queryByText("Label000")).toBeNull();
  expect(mocks.legacy).not.toHaveBeenCalled();
});

it("checks exact name independently before offering creation", async () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Edit labels" }));
  await screen.findByText("Label000");
  const input = screen.getByRole("searchbox", { name: "Search labels" });
  fireEvent.change(input, { target: { value: "Label050" } });
  await screen.findByText("Label050");
  expect(screen.queryByText("tasks:popover.labels.create")).toBeNull();
  fireEvent.change(input, { target: { value: "New name" } });
  await screen.findByText("tasks:popover.labels.create");
  expect(
    mocks.page.mock.calls.some(
      (call) =>
        call[0].query.exact === "true" && call[0].query.search === "New name",
    ),
  ).toBe(true);
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.legacy).not.toHaveBeenCalled();
});

it("does not infer name absence when exact lookup fails", async () => {
  const normal = mocks.page.getMockImplementation()!;
  mocks.page.mockImplementation((request, options) =>
    request.query.exact === "true"
      ? Promise.reject(new Error("Name check unavailable"))
      : normal(request, options),
  );
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Edit labels" }));
  await screen.findByText("Label000");
  fireEvent.change(screen.getByRole("searchbox", { name: "Search labels" }), {
    target: { value: "New name" },
  });
  await screen.findByText("Name check unavailable");
  expect(screen.queryByText("tasks:popover.labels.create")).toBeNull();
  expect(mocks.create).not.toHaveBeenCalled();
});
