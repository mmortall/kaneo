import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type Task from "@/types/task";
import { createTaskDescriptionSave } from "./task-description-save";

const task = (id = "fixture", version = 7) =>
  ({ id, version, description: "Base" }) as Task;
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("captures editor base rather than mutating fetched object at timer execution", async () => {
  const save = vi.fn(async (t: Task) => ({
    id: t.id,
    version: (t.version ?? 0) + 1,
  }));
  const queue = createTaskDescriptionSave(save, vi.fn());
  const fetched = task();
  queue.hydrate(fetched);
  queue.schedule("Draft");
  fetched.version = 8;
  await vi.advanceTimersByTimeAsync(700);
  expect(save.mock.calls[0][0]).toMatchObject({
    version: 7,
    description: "Draft",
  });
});

it("coalesces typing and serializes own saves, advancing only own committed revision", async () => {
  let resolve!: (value: { id: string; version: number }) => void;
  const save = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    )
    .mockImplementation(async (t: Task) => ({
      id: t.id,
      version: t.version! + 1,
    }));
  const queue = createTaskDescriptionSave(save, vi.fn());
  queue.hydrate(task());
  queue.schedule("First");
  await vi.advanceTimersByTimeAsync(700);
  queue.schedule("Second");
  queue.schedule("Latest");
  await vi.advanceTimersByTimeAsync(700);
  expect(save).toHaveBeenCalledTimes(1);
  resolve({ id: "fixture", version: 8 });
  await vi.advanceTimersByTimeAsync(0);
  expect(save).toHaveBeenCalledTimes(2);
  expect(save.mock.calls[1][0]).toMatchObject({
    version: 8,
    description: "Latest",
  });
  expect(queue.isDirty()).toBe(false);
});

it("conflict stops queued and subsequent autosaves until explicit hydration", async () => {
  const error = new Error("Conflict");
  const save = vi
    .fn()
    .mockRejectedValueOnce(error)
    .mockResolvedValue({ id: "fixture", version: 10 });
  const onError = vi.fn();
  const queue = createTaskDescriptionSave(save, onError);
  queue.hydrate(task());
  queue.schedule("Draft");
  await vi.advanceTimersByTimeAsync(700);
  queue.schedule("Still unsaved");
  await vi.advanceTimersByTimeAsync(700);
  expect(save).toHaveBeenCalledTimes(1);
  expect(onError).toHaveBeenCalledWith(error);
  expect(queue.isDirty()).toBe(true);
  queue.hydrate(task("fixture", 9));
  queue.schedule("Reconciled");
  await vi.advanceTimersByTimeAsync(700);
  expect(save.mock.calls[1][0].version).toBe(9);
});

it("task switch cancels delayed old draft and keeps next task identity", async () => {
  const save = vi.fn(async (t: Task) => ({
    id: t.id,
    version: t.version! + 1,
  }));
  const queue = createTaskDescriptionSave(save, vi.fn());
  queue.hydrate(task("old"));
  queue.schedule("Old draft");
  queue.hydrate(task("next", 3));
  queue.schedule("Next draft");
  await vi.advanceTimersByTimeAsync(700);
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0][0]).toMatchObject({ id: "next", version: 3 });
});

it("unmount cancellation prevents pending request", async () => {
  const save = vi.fn();
  const queue = createTaskDescriptionSave(save, vi.fn());
  queue.hydrate(task());
  queue.schedule("Draft");
  queue.cancel();
  await vi.advanceTimersByTimeAsync(700);
  expect(save).not.toHaveBeenCalled();
});

it("background hydration cannot replace pending draft or downgrade own committed revision", async () => {
  const save = vi.fn(async (t: Task) => ({
    id: t.id,
    version: t.version! + 1,
  }));
  const queue = createTaskDescriptionSave(save, vi.fn());
  queue.hydrate(task());
  queue.schedule("Draft");
  expect(queue.canHydrate(task("fixture", 8))).toBe(false);
  await vi.advanceTimersByTimeAsync(700);
  expect(queue.canHydrate(task("fixture", 7))).toBe(false);
  expect(queue.canHydrate(task("fixture", 8))).toBe(true);
});

it("completion from old task cannot advance next task revision", async () => {
  let resolve!: (value: { id: string; version: number }) => void;
  const save = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    )
    .mockImplementation(async (t: Task) => ({
      id: t.id,
      version: t.version! + 1,
    }));
  const queue = createTaskDescriptionSave(save, vi.fn());
  queue.hydrate(task("old", 7));
  queue.schedule("Old draft");
  await vi.advanceTimersByTimeAsync(700);
  queue.hydrate(task("next", 3));
  queue.schedule("Next draft");
  await vi.advanceTimersByTimeAsync(700);
  resolve({ id: "old", version: 8 });
  await vi.advanceTimersByTimeAsync(0);
  expect(save.mock.calls[1][0]).toMatchObject({
    id: "next",
    version: 3,
    description: "Next draft",
  });
});
