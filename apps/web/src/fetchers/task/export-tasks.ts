import { client } from "@kaneo/libs";

async function exportTasks(projectId: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);
  try {
    const fetchPage = async (cursor?: string) => {
      const response = await client.task.agent.export[":projectId"].$get(
        {
          param: { projectId },
          query: { limit: "100", ...(cursor ? { cursor } : {}) },
        },
        { init: { signal: controller.signal } },
      );
      if (!response.ok) throw new Error(await response.text());
      const page = await response.json();
      if (!page.pagination) throw new Error("Paged task export is unavailable");
      return page;
    };
    const first = await fetchPage();
    const tasks = [...first.tasks];
    let cursor = first.pagination?.nextCursor;
    const cursors = new Set<string>();
    while (cursor) {
      if (cursors.has(cursor))
        throw new Error("Task export returned a repeated cursor");
      cursors.add(cursor);
      const page = await fetchPage(cursor);
      tasks.push(...page.tasks);
      cursor = page.pagination?.nextCursor;
    }
    return { project: first.project, tasks };
  } finally {
    clearTimeout(timer);
  }
}

export default exportTasks;
