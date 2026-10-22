import { client } from "@kaneo/libs";
import type { InferRequestType } from "hono/client";
import { TaskConflictError } from "./update-task";

type Intent = InferRequestType<
  (typeof client.task.agent)["group-prepare"][":projectId"]["$post"]
>["json"];
export type TaskGroupSnapshot = {
  operationId: string;
  projectId: string;
  count: number;
  expiresAt: string;
  action: "archive_column" | "activate_planned";
  sourceStatus: string;
  targetStatus: string;
};

async function bounded<T>(
  call: (init: { signal: AbortSignal }) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    return await call({ signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function check(response: Response) {
  if (response.ok) return;
  if (response.status === 409 || response.status === 410)
    throw new TaskConflictError(
      "Task group changed or expired. Close and reopen this dialog to review a new snapshot.",
    );
  throw new Error(await response.text());
}

/** Preparation captures every matching task, regardless of visible page or filters. */
export function prepareTaskGroup(
  projectId: string,
  intent: Intent,
  key: string,
) {
  return bounded(async (init) => {
    const capability = await client.task.agent.capabilities.$get({}, { init });
    const capabilities: unknown = capability.ok
      ? await capability.json()
      : null;
    if (
      !capabilities ||
      typeof capabilities !== "object" ||
      !("completeTaskGroups" in capabilities) ||
      capabilities.completeTaskGroups !== true
    )
      throw new Error(
        "Server does not support complete task groups. Reload after upgrading Kaneo.",
      );
    const response = await client.task.agent["group-prepare"][
      ":projectId"
    ].$post(
      { param: { projectId }, json: intent },
      { init, headers: { "Idempotency-Key": key } },
    );
    await check(response);
    const result = await response.json();
    if (
      typeof result.operationId !== "string" ||
      !/^[a-f0-9]{64}$/.test(result.operationId) ||
      result.projectId !== projectId ||
      !Number.isSafeInteger(result.count) ||
      Number(result.count) < 0 ||
      typeof result.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(result.expiresAt)) ||
      result.action !== intent.action ||
      typeof result.sourceStatus !== "string" ||
      typeof result.targetStatus !== "string" ||
      (intent.action === "archive_column" &&
        (result.sourceStatus !== intent.sourceStatus ||
          result.targetStatus !== "archived")) ||
      (intent.action === "activate_planned" &&
        (result.sourceStatus !== "planned" ||
          result.targetStatus !== intent.targetStatus))
    )
      throw new Error("Invalid task group snapshot returned by server");
    return result as TaskGroupSnapshot;
  });
}

/** Manual retry uses same operation ID to reconcile an ambiguous committed result. */
export function applyTaskGroup(snapshot: TaskGroupSnapshot) {
  return bounded(async (init) => {
    const response = await client.task.agent["group-apply"][":projectId"][
      ":operationId"
    ].$post(
      {
        param: {
          projectId: snapshot.projectId,
          operationId: snapshot.operationId,
        },
      },
      { init },
    );
    await check(response);
    const result = await response.json();
    if (
      !("operationId" in result) ||
      !("projectId" in result) ||
      result.operationId !== snapshot.operationId ||
      result.projectId !== snapshot.projectId ||
      result.applied !== true ||
      result.updatedCount !== snapshot.count
    )
      throw new Error(
        "Task group result could not be confirmed. Retry to check the same operation.",
      );
    return { updatedCount: snapshot.count };
  });
}
