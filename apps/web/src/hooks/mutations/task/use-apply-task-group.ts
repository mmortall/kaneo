import { useMutation, useQueryClient } from "@tanstack/react-query";
import { applyTaskGroup } from "@/fetchers/task/task-group";

export function useApplyTaskGroup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: applyTaskGroup,
    retry: false,
    onSettled: (_data, _error, snapshot) => {
      queryClient.invalidateQueries({
        queryKey: ["task"],
        predicate: (query) => {
          const data = query.state.data;
          return (
            !!data &&
            typeof data === "object" &&
            "projectId" in data &&
            data.projectId === snapshot.projectId
          );
        },
      });
      for (const queryKey of [
        ["tasks", snapshot.projectId],
        ["tasks", "my"],
        ["projects"],
        ["activities"],
        ["notifications"],
      ]) {
        queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}
