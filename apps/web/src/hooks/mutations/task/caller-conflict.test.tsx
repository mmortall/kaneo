import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { TaskConflictError } from "@/fetchers/task/update-task";
import type Task from "@/types/task";
import { useUpdateTaskAssignee } from "./use-update-task-assignee";
import { useUpdateTaskDescription } from "./use-update-task-description";
import { useUpdateTaskDueDate } from "./use-update-task-due-date";
import { useUpdateTaskStatus } from "./use-update-task-status";
import { useUpdateTaskPriority } from "./use-update-task-status-priority";
import { useUpdateTaskTitle } from "./use-update-task-title";

const { mutation, errorToast } = vi.hoisted(() => ({
  mutation: vi.fn(),
  errorToast: vi.fn(),
}));
vi.mock("@kaneo/libs", () => ({ client: {} }));
vi.mock("@/lib/toast", () => ({ toast: { error: errorToast } }));
vi.mock("@/fetchers/task/update-task-description", () => ({
  default: mutation,
}));
vi.mock("@/fetchers/task/update-task-title", () => ({ default: mutation }));
vi.mock("@/fetchers/task/update-task-status", () => ({ default: mutation }));
vi.mock("@/fetchers/task/update-task-priority", () => ({ default: mutation }));
vi.mock("@/fetchers/task/update-task-assignee", () => ({ default: mutation }));
vi.mock("@/fetchers/task/update-task-due-date", () => ({ default: mutation }));

beforeEach(() => {
  mutation.mockReset();
  errorToast.mockReset();
});
for (const hook of [
  useUpdateTaskDescription,
  useUpdateTaskTitle,
  useUpdateTaskStatus,
  useUpdateTaskPriority,
  useUpdateTaskAssignee,
  useUpdateTaskDueDate,
]) {
  it(`${hook.name}: conflict refreshes task/list and is not retried`, async () => {
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const task = { id: "fixture", projectId: "project", version: 7 } as Task;
    client.setQueryData(["task", task.id], task);
    client.setQueryData(["tasks", task.projectId], [task]);
    const conflict = new TaskConflictError("Task changed; review latest data");
    mutation.mockRejectedValue(conflict);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result, unmount } = renderHook(hook, { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync(task)).rejects.toBe(conflict);
    });
    expect(client.getQueryState(["task", task.id])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["tasks", task.projectId])?.isInvalidated).toBe(
      true,
    );
    expect(errorToast).toHaveBeenCalledWith(conflict.message);
    expect(mutation).toHaveBeenCalledTimes(1);
    unmount();
    client.clear();
  });
}
