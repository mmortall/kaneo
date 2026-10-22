import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import useCreateLabel from "./use-create-label";
import useDeleteLabel from "./use-delete-label";
import useUpdateLabel from "./use-update-label";

const mocks = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock("@kaneo/libs", () => ({
  client: {
    label: {
      $post: mocks.write,
      ":id": { $put: mocks.write, $delete: mocks.write },
    },
  },
}));
beforeEach(() => vi.clearAllMocks());
const cases = ["create", "update", "delete"] as const;
it.each(
  cases.flatMap((operation) =>
    [200, 409, 503].map((status) => ({ operation, status })),
  ),
)(
  "$operation refreshes revision caches after HTTP$status without automatic retry",
  async ({ operation, status }) => {
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: 3, retryDelay: 0 } },
    });
    const keys = [
      ["tasks", "my"],
      ["task", "task"],
      ["task-relations", "task"],
      ["activities", "task"],
      ["notifications"],
    ];
    for (const key of keys)
      client.setQueryData(
        key,
        key[1] === "my"
          ? {
              projects: [],
              pagination: { page: 1, total: 0 },
              counts: { total: 0 },
            }
          : {},
      );
    mocks.write.mockResolvedValue(
      Response.json(
        {
          id: "label",
          name: "Label",
          color: "blue",
          workspaceId: "workspace",
          taskId: "task",
        },
        { status },
      ),
    );
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(
      () => ({
        create: useCreateLabel(),
        update: useUpdateLabel(),
        delete: useDeleteLabel(),
      }),
      { wrapper },
    );
    await act(async () => {
      const promise =
        operation === "create"
          ? hook.result.current.create.mutateAsync({
              name: "Label",
              color: "blue",
              taskId: "task",
              workspaceId: "workspace",
            })
          : operation === "update"
            ? hook.result.current.update.mutateAsync({
                id: "label",
                name: "Changed",
                color: "green",
              })
            : hook.result.current.delete.mutateAsync({ id: "label" });
      if (status === 200) await promise;
      else await expect(promise).rejects.toBeInstanceOf(Error);
    });
    expect(mocks.write).toHaveBeenCalledTimes(1);
    for (const key of keys)
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    hook.unmount();
    client.clear();
  },
);
