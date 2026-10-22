import { client } from "@kaneo/libs";
import type { InferRequestType } from "hono/client";
import type Task from "@/types/task";
import { TaskConflictError } from "./update-task";

type Request = InferRequestType<
  (typeof client.task.agent.order)[":id"]["$post"]
>["json"];
type Snapshot = Pick<Task, "id" | "version" | "projectId">;
export type TaskOrderInput = {
  task: Snapshot;
  status: string;
  anchor?: { task: Snapshot; placement: "before" | "after" };
};

/** Submit one relative move using caller snapshots and a stable operation key. */
export default async function orderTask({
  task,
  status,
  anchor,
}: TaskOrderInput) {
  for (const snapshot of [task, ...(anchor ? [anchor.task] : [])]) {
    if (!Number.isInteger(snapshot.version) || (snapshot.version ?? 0) < 1)
      throw new Error(
        "Reload tasks before reordering; task version is missing or invalid",
      );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const init = { signal: controller.signal };
    const capability = await client.task.agent.capabilities.$get({}, { init });
    if (
      !capability.ok ||
      (await capability.json()).relativeTaskOrdering !== true
    )
      throw new Error(
        "Server does not support relative task ordering. Reload after upgrading Kaneo.",
      );
    const json: Request = {
      projectId: task.projectId,
      expectedVersion: task.version!,
      status,
      ...(anchor
        ? {
            anchor: {
              id: anchor.task.id,
              expectedVersion: anchor.task.version!,
              placement: anchor.placement,
            },
          }
        : {}),
    };
    const response = await client.task.agent.order[":id"].$post(
      { param: { id: task.id }, json },
      { init, headers: { "Idempotency-Key": crypto.randomUUID() } },
    );
    if (!response.ok) {
      if (response.status === 409)
        throw new TaskConflictError(
          "Task or destination changed. Reloading latest data; review order before retrying.",
        );
      throw new Error(await response.text());
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}
