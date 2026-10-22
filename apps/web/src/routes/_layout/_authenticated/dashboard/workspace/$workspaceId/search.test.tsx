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

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@kaneo/libs", () => ({ client: { search: { $get: mocks.get } } }));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: object) => ({
    options,
    useParams: () => ({ workspaceId: "workspace" }),
  }),
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  useNavigate: () => vi.fn(),
}));
vi.mock("react-i18next", async (original) => ({
  ...(await original<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/common/workspace-layout", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/page-title", () => ({ default: () => null }));
vi.mock("@/lib/priority", () => ({ getPriorityIcon: () => null }));

import { Route } from "./search";

let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.get.mockImplementation(
    async ({ query }: { query: { taskArchive: string } }) =>
      Response.json({
        taskArchive: query.taskArchive,
        results: [
          {
            id: query.taskArchive,
            type: "task",
            title: `${query.taskArchive} result`,
            projectId: "project",
          },
        ],
        totalCount: 1,
      }),
  );
});
afterEach(() => {
  cleanup();
  client.clear();
});
function view() {
  const Component = Route.options.component as ComponentType;
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
}
it("loads only active search initially and switches explicitly to archive with isolated caches", async () => {
  view();
  expect(mocks.get).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "needle" },
  });
  await screen.findByText("active result");
  expect(mocks.get).toHaveBeenCalledOnce();
  expect(mocks.get.mock.calls[0][0].query).toMatchObject({
    q: "needle",
    taskArchive: "active",
  });
  fireEvent.click(screen.getByRole("button", { name: "Archive" }));
  await screen.findByText("archived result");
  expect(screen.queryByText("active result")).toBeNull();
  expect(mocks.get.mock.calls[1][0].query.taskArchive).toBe("archived");
  fireEvent.click(screen.getByRole("button", { name: "All tasks" }));
  await screen.findByText("all result");
  fireEvent.click(screen.getByRole("button", { name: "Active tasks" }));
  await screen.findByText("active result");
  await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(3));
});
it("shows legacy server error instead of archived results", async () => {
  mocks.get.mockImplementation(async () =>
    Response.json({ results: [{ id: "legacy", title: "Hidden legacy row" }] }),
  );
  view();
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "needle" },
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "does not support",
  );
  expect(screen.queryByText("Hidden legacy row")).toBeNull();
});
