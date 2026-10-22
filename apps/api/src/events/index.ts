import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";

const EVENTS = new EventEmitter();
EVENTS.setMaxListeners(100);
export const eventContext = new AsyncLocalStorage<{ initiatorId: string }>();
let activeHandlers = 0;
const strictDelivery = Symbol("strictDelivery");
const deliveryContext = new AsyncLocalStorage<boolean>();
export function isStrictEventDelivery(): boolean {
  return deliveryContext.getStore() === true;
}
export function eventBusSnapshot() {
  return { activeHandlers };
}

export type EventPayload<T = unknown> = {
  type: string;
  data: T;
  timestamp: string;
};

export async function shutdownEventBus(): Promise<void> {
  EVENTS.removeAllListeners();
}

export async function publishEvent(
  eventType: string,
  data: unknown,
): Promise<void> {
  let enhancedData = null;
  if (typeof data === "object" && data !== null) {
    const store = eventContext.getStore();
    enhancedData = { ...data, initiatorId: store?.initiatorId };
  }

  const payload: EventPayload = {
    type: eventType,
    data: enhancedData || data,
    timestamp: new Date().toISOString(),
  };

  try {
    EVENTS.emit(eventType, payload);
  } catch (error) {
    console.error("Failed to publish event:", error);
    throw error;
  }
}

/** Wait for direct subscribers; nested normal publications remain nonblocking. */
export async function publishEventAndWait(
  eventType: string,
  data: unknown,
): Promise<void> {
  const payload = {
    type: eventType,
    data,
    timestamp: new Date().toISOString(),
    [strictDelivery]: true,
  };
  const results = await Promise.allSettled(
    EVENTS.listeners(eventType).map((listener) => listener(payload)),
  );
  const errors = results.filter((result) => result.status === "rejected");
  if (errors.length)
    throw new AggregateError(
      errors.map((result) => result.reason),
      "Event subscriber failed",
    );
}

export async function subscribeToEvent<T>(
  eventType: string,
  handler: (data: T) => Promise<void>,
): Promise<void> {
  try {
    EVENTS.on(
      eventType,
      async (payload: EventPayload<T> & { [strictDelivery]?: boolean }) => {
        activeHandlers++;
        try {
          await deliveryContext.run(payload[strictDelivery] === true, () =>
            handler(payload.data),
          );
        } catch (error) {
          console.error(`Error processing event ${eventType}:`, error);
          if (payload[strictDelivery]) throw error;
        } finally {
          activeHandlers--;
        }
      },
    );
  } catch (error) {
    console.error("Failed to subscribe to event:", error);
    throw error;
  }
}

process.on("SIGTERM", () => {
  shutdownEventBus().catch(console.error);
});
