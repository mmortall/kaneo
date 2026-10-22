import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import useProjectStore from "@/store/project";
import type { ProjectWithTasks } from "@/types/project";
import { useBulkOperations } from "./use-bulk-operations";

const mocks = vi.hoisted(() => ({
  patch: vi.fn(),
  capability: vi.fn(),
  remove: vi.fn(),
  receipt: vi.fn(),
}));
vi.mock("@kaneo/libs", () => ({
  client: {
    task: {
      bulk: { $patch: mocks.patch },
      agent: {
        capabilities: { $get: mocks.capability },
        delete: {
          ":projectId": {
            $post: mocks.remove,
            receipt: { $get: mocks.receipt },
          },
        },
      },
    },
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mocks.receipt.mockImplementation(async () =>
    Response.json({ receipt: null }),
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
  mocks.capability.mockResolvedValue(
    Response.json({
      versionedBulkTaskFields: true,
      versionedBulkTaskLabels: true,
      deleteOperationReceipts: true,
    }),
  );
  mocks.patch.mockResolvedValue(
    Response.json({ success: true, updatedCount: 1 }),
  );
  useProjectStore.setState({
    project: {
      id: "project",
      columns: [{ tasks: [{ id: "task", version: 7 }] }],
      plannedTasks: [],
      archivedTasks: [],
      blockedTasks: [],
    } as unknown as ProjectWithTasks,
  });
});
type Operations = ReturnType<typeof useBulkOperations>;
const cases: {
  name: string;
  operation: string;
  value: string | null | undefined;
  run: (operations: Operations) => Promise<unknown>;
}[] = [
  {
    name: "delete",
    operation: "delete",
    value: undefined,
    run: (operations) => operations.bulkDelete(["task"]),
  },
  {
    name: "archive",
    operation: "updateStatus",
    value: "archived",
    run: (operations) => operations.bulkArchive(["task"]),
  },
  {
    name: "status",
    operation: "updateStatus",
    value: "doing",
    run: (operations) =>
      operations.bulkChangeStatus({ taskIds: ["task"], status: "doing" }),
  },
  {
    name: "assignee",
    operation: "updateAssignee",
    value: "user",
    run: (operations) =>
      operations.bulkAssign({ taskIds: ["task"], userId: "user" }),
  },
  {
    name: "backlog",
    operation: "updateStatus",
    value: "planned",
    run: (operations) => operations.bulkMoveToBacklog(["task"]),
  },
  {
    name: "board",
    operation: "updateStatus",
    value: "to-do",
    run: (operations) =>
      operations.bulkMoveToBoard({ taskIds: ["task"], status: "to-do" }),
  },
  {
    name: "priority",
    operation: "updatePriority",
    value: "high",
    run: (operations) =>
      operations.bulkPriority({ taskIds: ["task"], priority: "high" }),
  },
  {
    name: "clear due date",
    operation: "updateDueDate",
    value: null,
    run: (operations) =>
      operations.bulkDueDate({ taskIds: ["task"], dueDate: null }),
  },
  {
    name: "label",
    operation: "addLabel",
    value: "label",
    run: (operations) =>
      operations.bulkAddLabel({ taskIds: ["task"], labelId: "label" }),
  },
];
function setup() {
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
  for (const key of keys) client.setQueryData(key, {});
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(useBulkOperations, { wrapper });
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
it.each(cases)("sends loaded versions for $name in one write", async (test) => {
  const { hook, client, keys, close } = setup();
  await act(async () => {
    await test.run(hook.result.current);
  });
  if (test.operation === "delete") {
    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(mocks.remove.mock.calls[0][0]).toEqual({
      param: { projectId: "project" },
      json: { key: expect.any(String), tasks: [{ id: "task", version: 7 }] },
    });
    expect(mocks.patch).not.toHaveBeenCalled();
  } else {
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(mocks.patch.mock.calls[0]![0].json).toEqual({
      taskIds: ["task"],
      operation: test.operation,
      value: test.value,
      expectedVersions: [{ id: "task", version: 7 }],
    });
    expect(mocks.patch.mock.calls[0]![1].init.signal).toBe(
      mocks.capability.mock.calls[0]![1].init.signal,
    );
  }
  for (const key of keys)
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  close();
});
it.each([409, 403, 503])(
  "does not repeat bulk write after HTTP%i and refreshes caches",
  async (status) => {
    mocks.patch.mockResolvedValue(
      Response.json({ message: "Failed" }, { status }),
    );
    const { hook, client, keys, close } = setup();
    await act(async () => {
      await expect(
        hook.result.current.bulkArchive(["task"]),
      ).rejects.toBeInstanceOf(Error);
    });
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    for (const key of keys)
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    close();
  },
);
it("rejects missing snapshots before any HTTP call", async () => {
  const { hook, close } = setup();
  await act(async () => {
    await expect(hook.result.current.bulkArchive(["unloaded"])).rejects.toThrow(
      "version is missing",
    );
  });
  expect(mocks.patch).not.toHaveBeenCalled();
  expect(mocks.capability).not.toHaveBeenCalled();
  close();
});
it("fails closed on older server without unguarded fallback", async () => {
  mocks.capability.mockResolvedValue(Response.json({}));
  const { hook, close } = setup();
  await act(async () => {
    await expect(hook.result.current.bulkArchive(["task"])).rejects.toThrow(
      "does not support",
    );
  });
  expect(mocks.patch).not.toHaveBeenCalled();
  expect(mocks.capability).toHaveBeenCalledTimes(1);
  close();
});
it("reports ambiguous completion without retrying after lost write response", async () => {
  mocks.patch.mockRejectedValue(new TypeError("Failed to fetch"));
  const { hook, client, keys, close } = setup();
  await act(async () => {
    await expect(hook.result.current.bulkArchive(["task"])).rejects.toThrow(
      "may have committed",
    );
  });
  expect(mocks.patch).toHaveBeenCalledTimes(1);
  for (const key of keys)
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  close();
});
it("rejects oversized selection before HTTP instead of writing partial batches", async () => {
  const tasks = Array.from({ length: 101 }, (_, index) => ({
    id: `task-${index}`,
    version: 1,
  }));
  useProjectStore.setState({
    project: {
      id: "project",
      columns: [{ tasks }],
      plannedTasks: [],
      archivedTasks: [],
    } as unknown as ProjectWithTasks,
  });
  const { hook, close } = setup();
  await act(async () => {
    await expect(
      hook.result.current.bulkArchive(tasks.map((task) => task.id)),
    ).rejects.toThrow("up to 100");
  });
  expect(mocks.patch).not.toHaveBeenCalled();
  expect(mocks.capability).not.toHaveBeenCalled();
  close();
});
it("requires label capability even when field capability exists", async () => {
  mocks.capability.mockResolvedValue(
    Response.json({ versionedBulkTaskFields: true }),
  );
  const { hook, close } = setup();
  await act(async () => {
    await expect(
      hook.result.current.bulkAddLabel({ taskIds: ["task"], labelId: "label" }),
    ).rejects.toThrow("does not support");
  });
  expect(mocks.patch).not.toHaveBeenCalled();
  close();
});

it("requires independent delete capability and never falls back to individual unguarded deletes", async () => {
  mocks.capability.mockResolvedValue(
    Response.json({ versionedBulkTaskFields: true }),
  );
  const { hook, close } = setup();
  await act(async () => {
    await expect(hook.result.current.bulkDelete(["task"])).rejects.toThrow(
      "does not support",
    );
  });
  expect(mocks.patch).not.toHaveBeenCalled();
  close();
});
it("reports lost delete response without repeating deletion", async () => {
  mocks.remove.mockRejectedValue(new TypeError("Failed to fetch"));
  const { hook, close } = setup();
  await act(async () => {
    await expect(hook.result.current.bulkDelete(["task"])).rejects.toThrow(
      "Delete result is uncertain",
    );
  });
  expect(mocks.remove).toHaveBeenCalledOnce();
  close();
});
