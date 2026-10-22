import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type Task from "@/types/task";
import { useUpdateTaskStatus } from "./use-update-task-status";

const mocks = vi.hoisted(() => ({ patch: vi.fn() }));
vi.mock("@kaneo/libs", () => ({
  client: { task: { agent: { ":id": { $patch: mocks.patch } } } },
}));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());

it.each([200, 409])(
  "invalidates workspace pages after status response %i without replaying stale writes",
  async (status) => {
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: 3, retryDelay: 0 } },
    });
    const key = [
      "tasks",
      "my",
      "workspace",
      "user",
      { page: 2, category: "research" },
    ];
    client.setQueryData(key, { projects: [] });
    mocks.patch.mockResolvedValue(
      new Response(JSON.stringify({ id: "task", version: 8 }), { status }),
    );
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(useUpdateTaskStatus, { wrapper });
    const task = {
      id: "task",
      projectId: "project",
      version: 7,
      status: "done",
    } as Task;
    await act(async () => {
      if (status === 409)
        await expect(
          hook.result.current.mutateAsync(task),
        ).rejects.toBeInstanceOf(Error);
      else await hook.result.current.mutateAsync(task);
    });
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    hook.unmount();
    client.clear();
  },
);
