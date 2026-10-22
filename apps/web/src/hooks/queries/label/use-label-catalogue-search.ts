import { useEffect, useState } from "react";
import useGetLabelCatalogue from "./use-get-label-catalogue";

/** Debounce catalogue search and retain only requested page in each consumer. */
export default function useLabelCatalogueSearch(
  workspaceId: string,
  enabled = true,
  scope: "groups" | "definitions" = "groups",
) {
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => {
    if (input.trim() === search) return;
    const timer = setTimeout(() => {
      setSearch(input.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [input, search]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list kept as deployed; it intentionally re-runs or resets on these values
  useEffect(() => {
    setPage(1);
  }, [workspaceId]);
  const catalogue = useGetLabelCatalogue(
    workspaceId,
    { page, search, scope },
    enabled,
  );
  useEffect(() => {
    const last =
      catalogue.data && Math.max(1, catalogue.data.pagination.totalPages);
    if (last && page > last) setPage(last);
  }, [catalogue.data, page]);
  return {
    input,
    setInput,
    search,
    page,
    setPage,
    catalogue,
    busy: catalogue.isFetching || input.trim() !== search,
  };
}
