import { useQuery } from "@tanstack/react-query";
import getTaskView, {
  type TaskViewRequest,
} from "@/fetchers/task/get-task-view";

/** Keep each requested page separate; never refresh or collect the entire project. */
export function useGetTaskView(
  projectId: string,
  options: TaskViewRequest = {},
) {
  return useQuery({
    queryKey: ["tasks", projectId, "view", options],
    queryFn: ({ signal }) => getTaskView(projectId, options, signal),
    enabled: !!projectId,
    retry: false,
    staleTime: 10_000,
  });
}
