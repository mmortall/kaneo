import { useMutation, useQueryClient } from "@tanstack/react-query";
import deleteTask from "@/fetchers/task/delete-task";

export function useDeleteTask() {
  const queryClient = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: deleteTask,
    onSettled: (_, _error, task) => {
      for (const queryKey of [
        ["task", task.id],
        ["tasks"],
        ["projects"],
        ["task-relations"],
        ["activities"],
        ["notifications"],
      ])
        void queryClient.invalidateQueries({ queryKey });
    },
  });
}
