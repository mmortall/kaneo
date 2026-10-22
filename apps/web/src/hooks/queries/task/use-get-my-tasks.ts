import { useQuery } from "@tanstack/react-query";
import getMyTaskView, {
  type MyTaskViewRequest,
} from "@/fetchers/task/get-my-task-view";

export function useGetMyTasks(
  workspaceId: string,
  userId: string | undefined,
  options: MyTaskViewRequest,
) {
  const query = useQuery({
    queryKey: ["tasks", "my", workspaceId, userId, options],
    queryFn: ({ signal }) => getMyTaskView(workspaceId, options, signal),
    enabled: Boolean(workspaceId && userId),
    retry: false,
    staleTime: 10_000,
  });
  return {
    ...query,
    data: query.data?.projects ?? [],
    counts: query.data?.counts,
    pagination: query.data?.pagination,
    isLoading: !userId || query.isLoading,
  };
}
