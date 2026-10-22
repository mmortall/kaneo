import { client } from "@kaneo/libs";
import type { InferRequestType } from "hono/client";

export type GetProjectRequest = InferRequestType<
  (typeof client)["project"][":id"]["$get"]
>["param"] & {
  workspaceId: string;
};

/** Fetch metadata without task rows within one cancellable request budget. */
async function getProject({ id }: GetProjectRequest, signal?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const init = { signal: controller.signal };
    const capability = await client.task.agent.capabilities.$get({}, { init });
    if (!capability.ok || (await capability.json()).projectSummaries !== true) {
      throw new Error(
        "Server does not support project metadata queries. Reload after upgrading Kaneo.",
      );
    }
    const response = await client.project[":id"].$get(
      {
        param: { id },
        query: { summary: "true" },
      },
      { init },
    );
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    if ("tasks" in data)
      throw new Error("Project metadata response contains task rows");
    return data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export default getProject;
