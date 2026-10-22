import { useQuery } from "@tanstack/react-query";
import getLabelCatalogue, {
  type LabelCatalogueOptions,
} from "@/fetchers/label/get-label-catalogue";

/** Keep catalogue pages separate and cancel superseded searches. */
export default function useGetLabelCatalogue(
  workspaceId: string,
  options: LabelCatalogueOptions = {},
  enabled = true,
) {
  return useQuery({
    enabled: Boolean(workspaceId) && enabled,
    queryKey: ["labels", workspaceId, "catalogue", options],
    queryFn: ({ signal }) => getLabelCatalogue(workspaceId, options, signal),
    retry: false,
    staleTime: 10_000,
  });
}
