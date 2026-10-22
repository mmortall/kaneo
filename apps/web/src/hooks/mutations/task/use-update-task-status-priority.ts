import { useMutation, useQueryClient } from "@tanstack/react-query";
import updateTaskPriority from "@/fetchers/task/update-task-priority";
import type Task from "@/types/task";
import { useTaskMutationError } from "./use-task-mutation-error";

export function useUpdateTaskPriority() {
  const queryClient = useQueryClient();
  const onError = useTaskMutationError();

  return useMutation({
    onError,
    mutationFn: (task: Task) => updateTaskPriority(task.id, task),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["tasks", "my"] });
      queryClient.invalidateQueries({
        queryKey: ["task", variables.id],
      });
      queryClient.invalidateQueries({
        queryKey: ["tasks", variables.projectId],
      });
      queryClient.invalidateQueries({
        queryKey: ["notifications"],
      });
      queryClient.invalidateQueries({
        queryKey: ["projects"],
      });
      queryClient.invalidateQueries({
        queryKey: ["activities", variables.id],
      });
    },
  });
}
