import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { useGetMyTasks } from "./use-get-my-tasks";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/fetchers/task/get-my-task-view", () => ({ default: mocks.fetch }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockResolvedValue({
    projects: [],
    counts: { total: 20000 },
    pagination: { totalPages: 400 },
  });
});

it("requests only explicit page and disables anonymous query", async () => {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    ({ userId, page }: { userId?: string; page: number }) =>
      useGetMyTasks("workspace", userId, { page, category: "research" }),
    {
      wrapper,
      initialProps: { userId: undefined as string | undefined, page: 1 },
    },
  );
  expect(mocks.fetch).not.toHaveBeenCalled();
  hook.rerender({ userId: "user", page: 1 });
  await waitFor(() => expect(hook.result.current.counts?.total).toBe(20000));
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  hook.rerender({ userId: "user", page: 2 });
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
  expect(mocks.fetch.mock.calls[1][1]).toEqual({
    page: 2,
    category: "research",
  });
  hook.unmount();
  client.clear();
});
it("cancels active workspace request on unmount", async () => {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  mocks.fetch.mockImplementation(() => new Promise(() => {}));
  const hook = renderHook(
    () => useGetMyTasks("workspace", "user", { category: "research" }),
    { wrapper },
  );
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
  const signal = mocks.fetch.mock.calls[0][2] as AbortSignal;
  expect(signal.aborted).toBe(false);
  hook.unmount();
  expect(signal.aborted).toBe(true);
  client.clear();
});
