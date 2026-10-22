import { useQuery } from "@tanstack/react-query";
import getProject from "@/fetchers/project/get-project";

function useGetProject({
  id,
  workspaceId,
}: {
  id: string;
  workspaceId: string;
}) {
  return useQuery({
    queryFn: ({ signal }) => getProject({ id, workspaceId }, signal),
    queryKey: ["projects", workspaceId, id],
    enabled: !!id,
    retry: false,
  });
}

export default useGetProject;
