import { afterEach, describe, expect, it, vi } from "vitest";
import {
  publishEventAndWait,
  shutdownEventBus,
} from "../../../apps/api/src/events";
import {
  broadcastTaskDeleted,
  initializeEventSubscriptions,
  registerPlugin,
} from "../../../apps/api/src/plugins/registry";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("../../../apps/api/src/database", () => ({
  default: { query: { integrationTable: { findMany } } },
}));

describe("plugin durable delivery", () => {
  afterEach(async () => {
    await shutdownEventBus();
  });
  it("retries failed deletion and status hooks through actual event subscriptions", async () => {
    const onTaskDeleted = vi
      .fn()
      .mockRejectedValueOnce(new Error("Delete unavailable"))
      .mockResolvedValue(undefined);
    const onTaskStatusChanged = vi
      .fn()
      .mockRejectedValueOnce(new Error("Status unavailable"))
      .mockResolvedValue(undefined);
    registerPlugin({
      type: "delivery-test",
      name: "Delivery test",
      onTaskDeleted,
      onTaskStatusChanged,
      validateConfig: async () => ({ valid: true }),
    });
    findMany.mockResolvedValue([
      {
        id: "integration",
        projectId: "project",
        type: "delivery-test",
        config: "{}",
      },
    ]);
    initializeEventSubscriptions();
    const event = {
      taskId: "task",
      projectId: "project",
      title: "Reviewed task",
      userId: "user",
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(publishEventAndWait("task.deleted", event)).rejects.toThrow(
        "Event subscriber failed",
      );
      await expect(
        publishEventAndWait("task.deleted", event),
      ).resolves.toBeUndefined();
      const status = { ...event, oldStatus: "done", newStatus: "archived" };
      await expect(
        publishEventAndWait("task.status_changed", status),
      ).rejects.toThrow("Event subscriber failed");
      await expect(
        publishEventAndWait("task.status_changed", status),
      ).resolves.toBeUndefined();
      expect(onTaskDeleted).toHaveBeenCalledTimes(2);
      expect(onTaskStatusChanged).toHaveBeenCalledTimes(2);
      onTaskDeleted.mockRejectedValueOnce(new Error("Ordinary failure"));
      await expect(broadcastTaskDeleted(event)).resolves.toBeUndefined();
    } finally {
      log.mockRestore();
    }
  });
});
