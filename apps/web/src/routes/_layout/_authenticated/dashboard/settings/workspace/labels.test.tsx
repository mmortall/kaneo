import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Route } from "./labels";

const mocks = vi.hoisted(() => ({ page: vi.fn(), legacy: vi.fn(), total: 51 }));
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
  createFileRoute: () => (options: object) => ({ options }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
  initReactI18next: { type: "3rdParty", init: vi.fn() },
}));
vi.mock("@/components/page-title", () => ({ default: () => null }));
vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({
    workspace: { id: "workspace" },
    canManageLabels: () => true,
  }),
}));
vi.mock("@/hooks/mutations/label/use-create-label", () => ({
  default: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/mutations/label/use-update-label", () => ({
  default: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/mutations/label/use-delete-label", () => ({
  default: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

beforeEach(() => {
  mocks.page.mockReset();
  mocks.legacy.mockReset();
  mocks.total = 51;
  mocks.page.mockImplementation(({ query }) => {
    const page = Number(query.page);
    const total = query.search ? 1 : mocks.total;
    const offset = (page - 1) * 50;
    const items = Array.from(
      { length: Math.min(50, Math.max(0, total - offset)) },
      (_, index) => ({
        id: `label-${offset + index}`,
        name: query.search
          ? "Target"
          : `Label${String(offset + index).padStart(3, "0")}`,
        color: "gray",
        isWorkspaceLabel: true,
      }),
    );
    return Promise.resolve(
      new Response(
        JSON.stringify({
          items,
          pagination: {
            page,
            pageSize: 50,
            total,
            totalPages: Math.ceil(total / 50),
            hasMore: page * 50 < total,
            nextPage: page * 50 < total ? page + 1 : null,
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
  const Component = Route.options.component as ComponentType;
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
  return client;
}

it("uses definitions-only pages and resets server search to first page", async () => {
  mount();
  await screen.findByText("Label049");
  expect(screen.queryByText("Label050")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Label050");
  expect(screen.queryByText("Label000")).toBeNull();
  fireEvent.change(screen.getByRole("searchbox", { name: "Search labels" }), {
    target: { value: "Target" },
  });
  await screen.findByText("Target");
  expect(mocks.page.mock.calls.at(-1)?.[0].query).toMatchObject({
    page: "1",
    scope: "definitions",
    search: "Target",
  });
  expect(mocks.legacy).not.toHaveBeenCalled();
});

it("shows read failure and explicit retry instead of empty-label message", async () => {
  mocks.page.mockRejectedValueOnce(new Error("Catalogue unavailable"));
  mount();
  await screen.findByRole("alert");
  expect(screen.getByText("Catalogue unavailable")).toBeTruthy();
  expect(
    screen.queryByText(
      "No labels yet. Create your first label to get started.",
    ),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Label000");
  expect(mocks.legacy).not.toHaveBeenCalled();
});

it("returns to last available page after current final page becomes empty", async () => {
  const client = mount();
  await screen.findByText("Label000");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Label050");
  mocks.total = 50;
  await client.invalidateQueries({ queryKey: ["labels", "workspace"] });
  await waitFor(() => expect(screen.queryByText("Label050")).toBeNull());
  await screen.findByText("Label000");
  expect(mocks.page.mock.calls.at(-1)?.[0].query.page).toBe("1");
});
