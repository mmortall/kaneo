import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import getTasks from "@/fetchers/task/get-tasks";
import useGetProjects from "@/hooks/queries/project/use-get-projects";
import type { ProjectWithTasks } from "@/types/project";

export function useGetMyTasks(workspaceId: string, userId?: string) {
  const projectsQuery = useGetProjects({ workspaceId });
  const projects = projectsQuery.data ?? [];

  const taskQueries = useQueries({
    queries: projects.map((project) => ({
      queryKey: ["tasks", project.id, { assigneeId: userId }],
      queryFn: () => getTasks(project.id, { assigneeId: userId }),
      enabled: Boolean(project.id && userId),
      refetchInterval: 30000,
    })),
  });

  const data = useMemo(
    () =>
      taskQueries.flatMap((query) =>
        query.data ? [query.data as ProjectWithTasks] : [],
      ),
    [taskQueries],
  );

  return {
    data,
    isError:
      projectsQuery.isError || taskQueries.some((query) => query.isError),
    isLoading:
      !userId ||
      projectsQuery.isLoading ||
      (projects.length > 0 && taskQueries.some((query) => query.isLoading)),
    refetch: async () => {
      await Promise.all([
        projectsQuery.refetch(),
        ...taskQueries.map((query) => query.refetch()),
      ]);
    },
  };
}
