import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capability: vi.fn(),
  remove: vi.fn(),
  receipt: vi.fn(),
}));
vi.mock("@kaneo/libs", () => ({
  client: {
    task: {
      agent: {
        capabilities: { $get: mocks.capability },
        delete: {
          ":projectId": {
            $post: mocks.remove,
            receipt: { $get: mocks.receipt },
          },
        },
      },
      ":id": { $delete: mocks.remove },
    },
  },
}));

import deleteTask from "@/fetchers/task/delete-task";
import { useDeleteTask } from "./use-delete-task";

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  mocks.receipt.mockImplementation(async () =>
    Response.json({ receipt: null }),
  );
  mocks.capability.mockImplementation(async () =>
    Response.json({ deleteOperationReceipts: true }),
  );
  mocks.remove.mockImplementation(async () =>
    Response.json({
      operationId: "a".repeat(64),
      projectId: "project",
      success: true,
      deletedCount: 1,
      taskIds: ["task"],
    }),
  );
});
function view() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: 3, retryDelay: 0 } },
  });
  const keys = [
    ["task", "task"],
    ["tasks", "my"],
    ["task-relations", "task"],
    ["activities", "task"],
    ["notifications"],
    ["projects"],
  ];
  // biome-ignore lint/suspicious/useIterableCallbackReturn: setQueryData result is ignored
  keys.forEach((key) => client.setQueryData(key, {}));
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(useDeleteTask, { wrapper });
  return {
    hook,
    client,
    keys,
    close: () => {
      hook.unmount();
      client.clear();
    },
  };
}
const task = { id: "task", projectId: "project", version: 7 };
it("sends displayed version with one bounded delete and refreshes dependent caches", async () => {
  const { hook, client, keys, close } = view();
  await act(async () => {
    await hook.result.current.mutateAsync(task);
  });
  expect(mocks.remove).toHaveBeenCalledOnce();
  expect(mocks.remove.mock.calls[0][0]).toEqual({
    param: { projectId: "project" },
    json: { key: expect.any(String), tasks: [{ id: "task", version: 7 }] },
  });
  expect(mocks.remove.mock.calls[0][1].init.signal).toBe(
    mocks.capability.mock.calls[0][1].init.signal,
  );
  for (const key of keys)
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  close();
});
it.each([409, 403, 503])(
  "does not retry delete after HTTP%i",
  async (status) => {
    mocks.remove.mockImplementation(
      async () => new Response("Failed", { status }),
    );
    const { hook, close } = view();
    await act(async () => {
      await expect(
        hook.result.current.mutateAsync(task),
      ).rejects.toBeInstanceOf(Error);
    });
    expect(mocks.remove).toHaveBeenCalledOnce();
    close();
  },
);
it("reports lost response without replay and invalidates caches", async () => {
  mocks.remove.mockRejectedValue(new TypeError("Failed to fetch"));
  const { hook, client, keys, close } = view();
  await act(async () => {
    await expect(hook.result.current.mutateAsync(task)).rejects.toThrow(
      "Delete result is uncertain",
    );
  });
  expect(mocks.remove).toHaveBeenCalledOnce();
  for (const key of keys)
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  close();
});
it("rejects missing version before request and unsupported server before deletion", async () => {
  const { hook, close } = view();
  await act(async () => {
    await expect(
      hook.result.current.mutateAsync({ ...task, version: undefined }),
    ).rejects.toThrow("version is missing");
  });
  expect(mocks.capability).not.toHaveBeenCalled();
  mocks.capability.mockImplementation(async () => Response.json({}));
  await act(async () => {
    await expect(hook.result.current.mutateAsync(task)).rejects.toThrow(
      "does not support",
    );
  });
  expect(mocks.remove).not.toHaveBeenCalled();
  close();
});

it("shares20s budget across capability and delete and clears deadline", async () => {
  vi.useFakeTimers();
  try {
    mocks.capability.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve(Response.json({ deleteOperationReceipts: true })),
            15000,
          ),
        ),
    );
    mocks.remove.mockImplementation(
      (_input, options) =>
        new Promise((_resolve, reject) =>
          options.init.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          ),
        ),
    );
    const request = deleteTask(task);
    const failure = expect(request).rejects.toThrow(
      "Delete result is uncertain",
    );
    await vi.advanceTimersByTimeAsync(19999);
    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(mocks.remove.mock.calls[0][1].init.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failure;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
