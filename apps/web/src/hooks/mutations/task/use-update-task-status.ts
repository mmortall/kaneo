import { useMutation, useQueryClient } from "@tanstack/react-query";
import updateTaskStatus from "@/fetchers/task/update-task-status";
import type Task from "@/types/task";
import { useTaskMutationError } from "./use-task-mutation-error";

export function useUpdateTaskStatus() {
  const queryClient = useQueryClient();
  const onError = useTaskMutationError();

  return useMutation({
    retry: false,
    onError,
    mutationFn: (task: Task) => updateTaskStatus(task.id, task),
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
      queryClient.invalidateQueries({
        queryKey: ["task-relations"],
      });
    },
  });
}
