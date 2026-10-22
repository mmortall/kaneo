import { afterEach, describe, expect, it, vi } from "vitest";
import {
  eventBusSnapshot,
  eventContext,
  isStrictEventDelivery,
  publishEvent,
  publishEventAndWait,
  shutdownEventBus,
  subscribeToEvent,
} from "../../../apps/api/src/events/index";

describe("publishEvent / subscribeToEvent", () => {
  it("isolates strict delivery from nested ordinary events and concurrent handlers", async () => {
    const modes: boolean[] = [];
    await subscribeToEvent("test.mode.nested", async () => {
      await Promise.resolve();
      modes.push(isStrictEventDelivery());
    });
    await subscribeToEvent("test.mode.strict", async () => {
      expect(isStrictEventDelivery()).toBe(true);
      await publishEvent("test.mode.nested", {});
      await Promise.resolve();
      expect(isStrictEventDelivery()).toBe(true);
    });
    await Promise.all([
      publishEventAndWait("test.mode.strict", {}),
      publishEvent("test.mode.nested", {}),
    ]);
    expect(modes).toEqual([false, false]);
    expect(isStrictEventDelivery()).toBe(false);
  });
  afterEach(async () => {
    await shutdownEventBus();
  });

  it("delivers event data to a subscriber", async () => {
    const received: unknown[] = [];

    await subscribeToEvent("test.event", async (data) => {
      received.push(data);
    });

    await publishEvent("test.event", { foo: "bar" });

    // EventEmitter is synchronous so handler runs inline
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ foo: "bar" });
  });

  it("attaches initiatorId from eventContext store", async () => {
    const received: Array<{ initiatorId?: string }> = [];

    await subscribeToEvent<{ initiatorId?: string }>(
      "test.initiator",
      async (data) => {
        received.push(data);
      },
    );

    await eventContext.run({ initiatorId: "user-abc" }, async () => {
      await publishEvent("test.initiator", { taskId: "t1" });
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      taskId: "t1",
      initiatorId: "user-abc",
    });
  });

  it("sets initiatorId to undefined when no eventContext store exists", async () => {
    const received: Array<{ initiatorId?: string }> = [];

    await subscribeToEvent<{ initiatorId?: string }>(
      "test.no-context",
      async (data) => {
        received.push(data);
      },
    );

    await publishEvent("test.no-context", { taskId: "t2" });

    expect(received).toHaveLength(1);
    expect(received[0]?.initiatorId).toBeUndefined();
  });

  it("does not deliver events to unrelated subscribers", async () => {
    const received: unknown[] = [];

    await subscribeToEvent("other.event", async (data) => {
      received.push(data);
    });

    await publishEvent("test.unrelated", { value: 1 });

    expect(received).toHaveLength(0);
  });

  it("handles non-object data without attaching initiatorId", async () => {
    const received: unknown[] = [];

    await subscribeToEvent("test.primitive", async (data) => {
      received.push(data);
    });

    await publishEvent("test.primitive", "just a string");

    expect(received).toHaveLength(1);
    expect(received[0]).toBe("just a string");
  });

  it("shutdownEventBus removes all listeners", async () => {
    const received: unknown[] = [];

    await subscribeToEvent("test.shutdown", async (data) => {
      received.push(data);
    });

    await shutdownEventBus();
    await publishEvent("test.shutdown", { after: true });

    expect(received).toHaveLength(0);
  });
  it("ordinary event burst starts every asynchronous listener before any finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await subscribeToEvent("test.burst", async () => gate);
    for (let i = 0; i < 100; i++) await publishEvent("test.burst", i);
    expect(eventBusSnapshot().activeHandlers).toBe(100);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(eventBusSnapshot().activeHandlers).toBe(0);
  });
  it("awaitable event delivery waits for direct subscriber and permits nested publication", async () => {
    const received: unknown[] = [];
    await subscribeToEvent("test.nested", async (data) => {
      received.push(data);
    });
    await subscribeToEvent("test.await", async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await publishEvent("test.nested", "nested");
    });
    await publishEventAndWait("test.await", {});
    expect(received).toEqual(["nested"]);
    expect(eventBusSnapshot().activeHandlers).toBe(0);
  });
  it("awaitable delivery surfaces subscriber failure for durable retry", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await subscribeToEvent("test.fail", async () => {
        throw new Error("Controlled failure");
      });
      await expect(publishEventAndWait("test.fail", {})).rejects.toThrow(
        "Event subscriber failed",
      );
      expect(eventBusSnapshot().activeHandlers).toBe(0);
    } finally {
      log.mockRestore();
    }
  });
});
