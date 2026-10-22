import { useMutation, useQueryClient } from "@tanstack/react-query";
import updateTask, { TaskConflictError } from "@/fetchers/task/update-task";
import { toast } from "@/lib/toast";
import type Task from "@/types/task";

export function useUpdateTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (task: Task) => updateTask(task.id, task),
    onError: (error, task) => {
      if (error instanceof TaskConflictError) {
        toast.error(error.message);
        queryClient.invalidateQueries({ queryKey: ["task", task.id] });
        queryClient.invalidateQueries({ queryKey: ["tasks", task.projectId] });
      }
    },
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
