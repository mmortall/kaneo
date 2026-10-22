import { afterEach, expect, it, vi } from "vitest";
import {
  startTaskGroupMetrics,
  stopTaskGroupMetrics,
} from "../../../apps/api/src/events/task-group-metrics";
import {
  startTaskGroupEventWorker,
  stopTaskGroupEventWorker,
} from "../../../apps/api/src/events/task-group-worker";

const { transaction } = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("../../../apps/api/src/database", () => ({ default: { transaction } }));
vi.mock("../../../apps/api/src/storage/cleanup-assets", () => ({
  deleteS3Keys: vi.fn(),
}));
vi.mock("../../../apps/api/src/events/index", () => ({
  eventContext: {},
  publishEventAndWait: vi.fn(),
}));

afterEach(() => {
  stopTaskGroupEventWorker();
  stopTaskGroupMetrics();
  vi.useRealTimers();
  transaction.mockReset();
});

it("does not revive old sampler loop when restart happens during refresh", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  transaction.mockReturnValue(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  startTaskGroupMetrics();
  stopTaskGroupMetrics();
  startTaskGroupMetrics();
  expect(transaction).toHaveBeenCalledOnce();
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(1);
  stopTaskGroupMetrics();
  expect(vi.getTimerCount()).toBe(0);
});

it("retains one worker and sampler timer after stop-start during drain", async () => {
  vi.useFakeTimers();
  const releases: (() => void)[] = [];
  transaction.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      }),
  );
  startTaskGroupEventWorker();
  stopTaskGroupEventWorker();
  startTaskGroupEventWorker();
  expect(transaction).toHaveBeenCalledTimes(2);
  for (const release of releases) release();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(2);
  stopTaskGroupEventWorker();
  expect(vi.getTimerCount()).toBe(0);
});
