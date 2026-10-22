import { useMutation, useQueryClient } from "@tanstack/react-query";
import deleteLabel from "@/fetchers/label/delete-label";
import invalidateLabelTaskCaches from "./invalidate-label-task-caches";
import { removeLabelFromTaskInTasksCache } from "./sync-task-labels-cache";

function useDeleteLabel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: deleteLabel,
    retry: false,
    onSettled: () => invalidateLabelTaskCaches(queryClient),
    onSuccess: (deletedLabel) => {
      queryClient.setQueryData(
        ["labels", deletedLabel.workspaceId],
        (existingLabels: Array<typeof deletedLabel> | undefined) =>
          existingLabels?.filter((label) => label.id !== deletedLabel.id) ?? [],
      );

      if (deletedLabel.taskId) {
        queryClient.setQueryData(
          ["labels", deletedLabel.taskId],
          (existingLabels: Array<typeof deletedLabel> | undefined) =>
            existingLabels?.filter((label) => label.id !== deletedLabel.id) ??
            [],
        );

        removeLabelFromTaskInTasksCache(
          queryClient,
          deletedLabel.taskId,
          deletedLabel.id,
        );
      }
    },
  });
}

export default useDeleteLabel;
