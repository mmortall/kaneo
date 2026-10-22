import { useMutation, useQueryClient } from "@tanstack/react-query";
import patchTask, { type TaskPatchFields } from "@/fetchers/task/patch-task";
import { TaskConflictError } from "@/fetchers/task/update-task";
import { toast } from "@/lib/toast";
import type Task from "@/types/task";
import { useTaskMutationError } from "./use-task-mutation-error";

type Variables = {
  task: Pick<Task, "id" | "version" | "projectId">;
  fields: TaskPatchFields;
};

export function useUpdateTaskFields() {
  const queryClient = useQueryClient();
  const conflict = useTaskMutationError();
  return useMutation({
    retry: false,
    mutationFn: ({ task, fields }: Variables) =>
      patchTask(task.id, task.version, fields),
    onError: (error, { task }) => {
      conflict(error, task);
      if (!(error instanceof TaskConflictError)) {
        toast.error(error.message);
        queryClient.invalidateQueries({ queryKey: ["tasks", task.projectId] });
        queryClient.invalidateQueries({ queryKey: ["tasks", "my"] });
      }
    },
    onSuccess: (_, { task }) => {
      for (const queryKey of [
        ["task", task.id],
        ["tasks", task.projectId],
        ["tasks", "my"],
        ["notifications"],
        ["projects"],
        ["activities", task.id],
      ]) {
        queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}
