import { client } from "@kaneo/libs";

type SearchParams = {
  q: string;
  type?:
    | "all"
    | "tasks"
    | "projects"
    | "workspaces"
    | "comments"
    | "activities";
  workspaceId?: string;
  projectId?: string;
  limit?: number;
  taskArchive?: "active" | "archived" | "all";
};

async function globalSearch(params: SearchParams, signal?: AbortSignal) {
  const queryParams = {
    ...params,
    taskArchive: params.taskArchive ?? "active",
    limit: params.limit?.toString(),
  };

  const response = await client.search.$get(
    {
      query: queryParams,
    },
    { init: { signal } },
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  const data = await response.json();

  if (data.taskArchive !== (params.taskArchive ?? "active")) {
    throw new Error(
      "Server does not support archive-scoped search. Reload after upgrading Kaneo.",
    );
  }
  return data;
}

export default globalSearch;
