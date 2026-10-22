import { useQueryClient } from "@tanstack/react-query";
import { TaskConflictError } from "@/fetchers/task/update-task";
import { toast } from "@/lib/toast";
import type Task from "@/types/task";

export function useTaskMutationError() {
  const queryClient = useQueryClient();
  return (error: Error, task: Pick<Task, "id" | "projectId">) => {
    if (error instanceof TaskConflictError) {
      queryClient.invalidateQueries({ queryKey: ["task", task.id] });
      queryClient.invalidateQueries({ queryKey: ["tasks", task.projectId] });
      queryClient.invalidateQueries({ queryKey: ["tasks", "my"] });
      toast.error(error.message);
    }
  };
}
