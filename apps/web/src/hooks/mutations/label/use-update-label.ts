import { useMutation, useQueryClient } from "@tanstack/react-query";
import updateLabel from "@/fetchers/label/update-label";
import invalidateLabelTaskCaches from "./invalidate-label-task-caches";

function useUpdateLabel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: updateLabel,
    retry: false,
    onSettled: () => invalidateLabelTaskCaches(queryClient),
  });
}

export default useUpdateLabel;
