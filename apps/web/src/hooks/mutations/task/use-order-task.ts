import { useMutation, useQueryClient } from "@tanstack/react-query";
import orderTask from "@/fetchers/task/order-task";
import { toast } from "@/lib/toast";

export function useOrderTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: orderTask,
    retry: false,
    onSettled: (_data, _error, { task, anchor }) => {
      queryClient.invalidateQueries({
        queryKey: ["task"],
        predicate: (query) => {
          const data = query.state.data;
          return (
            !!data &&
            typeof data === "object" &&
            "projectId" in data &&
            data.projectId === task.projectId
          );
        },
      });
      for (const queryKey of [
        ["task", task.id],
        ["tasks", task.projectId],
        ["tasks", "my"],
        ["projects"],
        ["task-relations"],
        ["activities", task.id],
        ["notifications"],
      ]) {
        queryClient.invalidateQueries({ queryKey });
      }
      if (anchor)
        queryClient.invalidateQueries({ queryKey: ["task", anchor.task.id] });
    },
    onError: (error) => toast.error(error.message),
  });
}
