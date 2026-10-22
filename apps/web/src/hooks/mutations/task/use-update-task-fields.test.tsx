import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { useUpdateTaskFields } from "./use-update-task-fields";

const mocks = vi.hoisted(() => ({ send: vi.fn(), error: vi.fn() }));
vi.mock("@kaneo/libs", () => ({
  client: { task: { agent: { ":id": { $patch: mocks.send } } } },
}));
vi.mock("@/lib/toast", () => ({ toast: { error: mocks.error } }));
beforeEach(() => {
  vi.clearAllMocks();
});

function setup() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: 3, retryDelay: 0 } },
  });
  const task = { id: "task", projectId: "project", version: 7 };
  client.setQueryData(["task", task.id], task);
  client.setQueryData(["tasks", task.projectId, "view", { page: 1 }], [task]);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, task, ...renderHook(useUpdateTaskFields, { wrapper }) };
}

it("sends explicit fields and caller revision, then invalidates paginated views", async () => {
  mocks.send.mockResolvedValue(
    new Response(JSON.stringify({ id: "task", version: 8 })),
  );
  const { client, task, result, unmount } = setup();
  await act(async () => {
    await result.current.mutateAsync({
      task,
      fields: { status: "planned", position: 11 },
    });
  });
  expect(mocks.send.mock.calls[0][0]).toEqual({
    param: { id: "task" },
    json: { status: "planned", position: 11, expectedVersion: 7 },
  });
  expect(
    client.getQueryState(["tasks", task.projectId, "view", { page: 1 }])
      ?.isInvalidated,
  ).toBe(true);
  unmount();
  client.clear();
});

it.each([409, 403])(
  "refreshes optimistic list and surfaces HTTP %i without retry",
  async (status) => {
    mocks.send.mockImplementation(() =>
      Promise.resolve(new Response("Rejected", { status })),
    );
    const { client, task, result, unmount } = setup();
    await act(async () => {
      await expect(
        result.current.mutateAsync({ task, fields: { status: "archived" } }),
      ).rejects.toBeInstanceOf(Error);
    });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalledTimes(1);
    expect(
      client.getQueryState(["tasks", task.projectId, "view", { page: 1 }])
        ?.isInvalidated,
    ).toBe(true);
    unmount();
    client.clear();
  },
);
