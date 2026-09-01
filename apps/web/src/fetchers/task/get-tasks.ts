import { client } from "@kaneo/libs";

type GetTasksFilters = {
  assigneeId?: string;
};

async function getTasks(projectId: string, filters: GetTasksFilters = {}) {
  const response = await client.task.tasks[":projectId"].$get({
    param: { projectId },
    query: filters,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  const json = await response.json();

  return json.data;
}

export default getTasks;
