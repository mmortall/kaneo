import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { useOrderTask } from "./use-order-task";

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  capability: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@kaneo/libs", () => ({
  client: {
    task: {
      agent: {
        capabilities: { $get: mocks.capability },
        order: { ":id": { $post: mocks.post } },
      },
    },
  },
}));
vi.mock("@/lib/toast", () => ({ toast: { error: mocks.error } }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.capability.mockResolvedValue(
    Response.json({ relativeTaskOrdering: true }),
  );
});
it.each([200, 409, 403])(
  "refreshes affected caches after HTTP %i without mutation retries",
  async (status) => {
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: 3, retryDelay: 0 } },
    });
    const keys = [
      ["tasks", "project", "view", { page: 3 }],
      ["tasks", "my"],
      ["task", "hidden-neighbor"],
    ];
    for (const key of keys) client.setQueryData(key, { projectId: "project" });
    mocks.post.mockResolvedValue(
      Response.json({ id: "task", version: 8 }, { status }),
    );
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(useOrderTask, { wrapper });
    await act(async () => {
      const promise = hook.result.current.mutateAsync({
        task: { id: "task", projectId: "project", version: 7 },
        status: "planned",
      });
      if (status === 200) await promise;
      else await expect(promise).rejects.toBeInstanceOf(Error);
    });
    expect(mocks.post).toHaveBeenCalledTimes(1);
    for (const key of keys)
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    expect(mocks.error).toHaveBeenCalledTimes(status === 200 ? 0 : 1);
    hook.unmount();
    client.clear();
  },
);
