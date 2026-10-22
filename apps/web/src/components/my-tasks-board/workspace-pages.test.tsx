import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Route } from "@/routes/_layout/_authenticated/dashboard/workspace/$workspaceId/my-tasks";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  search: { category: "live_implementation" },
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: object) => ({
    ...options,
    useParams: () => ({ workspaceId: "workspace" }),
    useSearch: () => mocks.search,
  }),
  useNavigate: () => mocks.navigate,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: object) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "user" } } }) },
}));
vi.mock("@/hooks/queries/task/use-get-my-tasks", () => ({
  useGetMyTasks: (...args: unknown[]) => mocks.query(...args),
}));
vi.mock("@/components/common/workspace-layout", () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/page-title", () => ({ default: () => null }));
vi.mock("@/components/task/task-details-sheet", () => ({
  default: () => null,
}));
vi.mock("@/components/my-tasks-board", () => ({
  default: ({ projects }: { projects: { id: string }[] }) => (
    <div>{projects[0]?.id}</div>
  ),
}));
const Page = (Route as unknown as { component: ComponentType }).component;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.search = { category: "live_implementation" };
  mocks.query.mockImplementation((_workspace, _user, options) => ({
    data: [{ id: `page-${options.page}` }],
    isLoading: false,
    isFetching: false,
    isError: false,
    counts: {
      allCategoriesTotal: 20000,
      total: 10000,
      projectCount: 100,
      todoByCategory: {
        live_implementation: 9000,
        research: 8000,
        agent_blocker: 3000,
      },
    },
    pagination: { totalPages: 200, hasMore: true },
    refetch: vi.fn(),
  }));
});
afterEach(cleanup);

it("shows complete counts and explicitly navigates bounded pages", () => {
  render(<Page />);
  expect(screen.getByText(/tasks:myTasks.summary.*20000.*100/)).toBeVisible();
  expect(screen.getByText("page-1")).toBeVisible();
  expect(mocks.query).toHaveBeenLastCalledWith("workspace", "user", {
    page: 1,
    category: "live_implementation",
    horizon: undefined,
  });
  fireEvent.click(
    screen.getByRole("button", { name: "common:pagination.nextPage" }),
  );
  expect(screen.getByText("page-2")).toBeVisible();
  expect(mocks.query).toHaveBeenLastCalledWith("workspace", "user", {
    page: 2,
    category: "live_implementation",
    horizon: undefined,
  });
});
it("resets page before querying a changed category", () => {
  const { rerender } = render(<Page />);
  fireEvent.click(
    screen.getByRole("button", { name: "common:pagination.nextPage" }),
  );
  mocks.search = { category: "research" };
  mocks.query.mockClear();
  rerender(<Page />);
  expect(mocks.query.mock.calls.every((call) => call[2].page === 1)).toBe(true);
  expect(mocks.query).toHaveBeenLastCalledWith("workspace", "user", {
    page: 1,
    category: "research",
    horizon: undefined,
  });
});
