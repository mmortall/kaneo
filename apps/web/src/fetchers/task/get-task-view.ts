import { client } from "@kaneo/libs";
import type { InferRequestType } from "hono/client";

export type TaskViewRequest = InferRequestType<
  (typeof client.task.agent.view)[":projectId"]["$post"]
>["json"];

/** Fetch one summary page within one cancellable interactive budget. */
export default async function getTaskView(
  projectId: string,
  options: TaskViewRequest = {},
  signal?: AbortSignal,
) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const init = { signal: controller.signal };
    const capability = await client.task.agent.capabilities.$get({}, { init });
    const capabilities = capability.ok ? await capability.json() : undefined;
    if (
      capabilities?.filteredTaskViews !== true ||
      (options.filters?.labelGroupIds?.length &&
        capabilities.labelGroupIdViews !== true) ||
      (options.filters?.labelGroupKeys?.length &&
        capabilities.labelGroupKeyViews !== true) ||
      (options.filters?.excludeStatuses?.length &&
        capabilities.taskViewExclusions !== true) ||
      ((options.filters?.scheduledOnly ||
        options.filters?.searchStatus ||
        options.sortBy === "scheduleStart") &&
        capabilities?.scheduledTaskViews !== true)
    ) {
      throw new Error(
        "Server does not support paginated task views. Reload after upgrading Kaneo.",
      );
    }
    const response = await client.task.agent.view[":projectId"].$post(
      {
        param: { projectId },
        json: {
          ...options,
          page: options.page ?? 1,
          limit: options.limit ?? 50,
        },
      },
      { init },
    );
    if (!response.ok) throw new Error(await response.text());
    const body = await response.json();
    const pagination = body.pagination;
    if (
      !pagination ||
      !("hasMore" in pagination) ||
      pagination.total === null ||
      pagination.totalPages === null ||
      !body.data.countsByStatus
    ) {
      throw new Error("Task view pagination or counts are unavailable");
    }
    if (
      !Number.isSafeInteger(pagination.total) ||
      pagination.total < 0 ||
      !Number.isSafeInteger(pagination.totalPages) ||
      pagination.totalPages < 1 ||
      pagination.page !== (options.page ?? 1) ||
      pagination.pageSize !== (options.limit ?? 50) ||
      typeof pagination.hasMore !== "boolean" ||
      pagination.nextPage !== (pagination.hasMore ? pagination.page + 1 : null)
    ) {
      throw new Error("Task view returned invalid pagination");
    }
    if (options.filters?.scheduledOnly) {
      const bounds = body.data.scheduleBounds;
      if (
        !bounds ||
        (pagination.total === 0
          ? bounds.start !== null || bounds.end !== null
          : typeof bounds.start !== "string" ||
            typeof bounds.end !== "string" ||
            !Number.isFinite(Date.parse(bounds.start)) ||
            !Number.isFinite(Date.parse(bounds.end)) ||
            Date.parse(bounds.start) > Date.parse(bounds.end))
      ) {
        throw new Error(
          "Scheduled task view bounds are unavailable or invalid",
        );
      }
    }
    const summary = <T>(task: T) => ({ ...task, isSummary: true as const });
    return {
      ...body,
      pagination,
      data: {
        ...body.data,
        columns: body.data.columns.map((column) => ({
          ...column,
          tasks: column.tasks.map(summary),
        })),
        archivedTasks: body.data.archivedTasks.map(summary),
        plannedTasks: body.data.plannedTasks.map(summary),
        blockedTasks: body.data.blockedTasks.map(summary),
      },
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
