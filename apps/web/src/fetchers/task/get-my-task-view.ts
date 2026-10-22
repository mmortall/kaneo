import { client } from "@kaneo/libs";
import type { InferRequestType } from "hono/client";

export type MyTaskViewRequest = InferRequestType<
  (typeof client.task.agent)["my-view"][":workspaceId"]["$post"]
>["json"];

/** Fetch one assigned-task page across workspace, without per-project polling. */
export default async function getMyTaskView(
  workspaceId: string,
  options: MyTaskViewRequest,
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
    if (
      !capability.ok ||
      (await capability.json()).workspaceTaskViews !== true
    ) {
      throw new Error(
        "Server does not support workspace task pages. Reload after upgrading Kaneo.",
      );
    }
    const response = await client.task.agent["my-view"][":workspaceId"].$post(
      {
        param: { workspaceId },
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
    const { pagination, counts } = body;
    if (
      !pagination ||
      !counts ||
      !Number.isSafeInteger(pagination.total) ||
      pagination.total < 0 ||
      !Number.isSafeInteger(pagination.totalPages) ||
      pagination.totalPages < 1 ||
      pagination.page !== (options.page ?? 1) ||
      pagination.pageSize !== (options.limit ?? 50) ||
      typeof pagination.hasMore !== "boolean" ||
      pagination.nextPage !==
        (pagination.hasMore ? pagination.page + 1 : null) ||
      counts.total !== pagination.total
    )
      throw new Error("Workspace task view returned invalid pagination");
    const summary = <T>(task: T) => ({ ...task, isSummary: true as const });
    return {
      ...body,
      projects: body.projects.map((project) => ({
        ...project,
        columns: project.columns.map((column) => ({
          ...column,
          tasks: column.tasks.map(summary),
        })),
        plannedTasks: project.plannedTasks.map(summary),
        archivedTasks: project.archivedTasks.map(summary),
        blockedTasks: project.blockedTasks.map(summary),
      })),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
