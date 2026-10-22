import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

type Pagination = {
  page: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
};

/** Expose further label pages without collecting assignment rows. */
export function LabelCataloguePager({
  pagination,
  busy,
  onPage,
}: {
  pagination?: Pagination;
  busy?: boolean;
  onPage: (page: number) => void;
}) {
  const { t } = useTranslation();
  if (!pagination) return null;
  return (
    <nav
      aria-label={t("common:labelPagination", { defaultValue: "Label pages" })}
      className="flex items-center justify-between gap-2 py-2 text-sm"
    >
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy || !pagination || pagination.page <= 1}
        onClick={() => pagination && onPage(pagination.page - 1)}
      >
        {t("common:previous", { defaultValue: "Previous" })}
      </Button>
      <span aria-live="polite" className="text-muted-foreground">
        {pagination
          ? t("common:labelPageCount", {
              defaultValue: "Page {{page}} of {{pages}} · {{count}} labels",
              page: pagination.page,
              pages: Math.max(1, pagination.totalPages),
              count: pagination.total,
            })
          : t("common:loading", { defaultValue: "Loading…" })}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy || !pagination?.hasMore}
        onClick={() => pagination && onPage(pagination.page + 1)}
      >
        {t("common:next", { defaultValue: "Next" })}
      </Button>
    </nav>
  );
}
