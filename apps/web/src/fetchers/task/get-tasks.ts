import { client } from "@kaneo/libs";

type GetTasksFilters = {
  assigneeId?: string;
};

async function getTasks(projectId: string, filters: GetTasksFilters = {}) {
  const response = await client.task.tasks[":projectId"].$get({
    param: { projectId },
    query: {
      ...filters,
      page: "1",
      limit: "100",
      sortBy: "number",
      sortOrder: "asc",
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  const json = await response.json();

  const data = json.data;
  // Board needs every column and virtual status; fetch bounded pages explicitly.
  for (let page = 2; page <= json.pagination.totalPages; page++) {
    const next = await client.task.tasks[":projectId"].$get({
      param: { projectId },
      query: {
        ...filters,
        page: String(page),
        limit: "100",
        sortBy: "number",
        sortOrder: "asc",
      },
    });
    if (!next.ok) throw new Error(await next.text());
    const body = await next.json();
    for (const column of data.columns) {
      column.tasks.push(
        ...(body.data.columns.find((c) => c.id === column.id)?.tasks ?? []),
      );
    }
    data.archivedTasks.push(...body.data.archivedTasks);
    data.plannedTasks.push(...body.data.plannedTasks);
    data.blockedTasks.push(...body.data.blockedTasks);
  }
  return data;
}

export default getTasks;
