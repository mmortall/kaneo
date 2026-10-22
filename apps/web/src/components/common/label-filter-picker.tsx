import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import useLabelCatalogueSearch from "@/hooks/queries/label/use-label-catalogue-search";
import {
  labelGroupSelection,
  parseLabelGroupSelection,
} from "@/lib/label-filter-selection";
import { LabelCataloguePager } from "./label-catalogue-pager";

/** Select complete groups from one catalogue page without expanding assignment IDs. */
export default function LabelFilterPicker({
  workspaceId,
  selected,
  onChange,
}: {
  workspaceId: string;
  selected: readonly string[];
  onChange: (values: string[] | null) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const search = useLabelCatalogueSearch(workspaceId, open);
  const groups = selected
    .map(parseLabelGroupSelection)
    .filter((group) => !!group);
  const legacyCount = selected.length - groups.length;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button type="button" size="sm" variant="outline" />}
      >
        {t("tasks:properties.labels")}
        {selected.length ? ` (${selected.length})` : ""}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-80 p-2">
        <PopoverTitle className="text-sm">
          {t("tasks:properties.labels")}
        </PopoverTitle>
        <Input
          type="search"
          aria-label={t("common:searchLabels", {
            defaultValue: "Search labels",
          })}
          value={search.input}
          onChange={(event) => search.setInput(event.target.value)}
        />
        {legacyCount > 0 && (
          <p className="text-sm text-muted-foreground">
            {t("common:savedLabelAssignments", {
              defaultValue:
                "{{count}} saved individual label selections remain active",
              count: legacyCount,
            })}
          </p>
        )}
        {groups.length >= 100 && (
          <p role="status">
            {t("common:labelFilterLimit", {
              defaultValue:
                "Up to 100 label groups can be selected. Remove a group to select another.",
            })}
          </p>
        )}
        {selected.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(null)}
          >
            {t("common:clearLabels", { defaultValue: "Clear label filters" })}
          </Button>
        )}
        {groups.length > 0 && (
          // biome-ignore lint/a11y/useAriaPropsSupportedByRole: label names the scroll region as deployed
          <div
            className="max-h-24 overflow-y-auto"
            aria-label={t("common:selectedLabels", {
              defaultValue: "Selected labels",
            })}
          >
            {selected
              .filter((value) => parseLabelGroupSelection(value))
              .map((value) => {
                const group = parseLabelGroupSelection(value)!;
                return (
                  <Button
                    key={value}
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="max-w-full"
                    aria-label={t("common:removeLabelFilter", {
                      defaultValue: "Remove {{name}} ({{color}})",
                      name: group.name,
                      color: group.color,
                    })}
                    onClick={() => {
                      const values = selected.filter((item) => item !== value);
                      onChange(values.length ? values : null);
                    }}
                  >
                    <span className="truncate">
                      {group.name} ({group.color})
                    </span>
                    <span aria-hidden="true">×</span>
                  </Button>
                );
              })}
          </div>
        )}
        {search.catalogue.isError ? (
          <div role="alert">
            <p>{search.catalogue.error.message}</p>
            <Button
              type="button"
              disabled={search.busy}
              onClick={() => void search.catalogue.refetch()}
            >
              {t("common:retry", { defaultValue: "Retry" })}
            </Button>
          </div>
        ) : search.catalogue.isPending ? (
          <p role="status">
            {t("common:loading", { defaultValue: "Loading…" })}
          </p>
        ) : (
          <div className="max-h-64 overflow-y-auto">
            {(search.catalogue.data?.items ?? []).map((label) => {
              const matching = selected.filter((value) => {
                const group = parseLabelGroupSelection(value);
                return (
                  group?.name === label.name && group.color === label.color
                );
              });
              const checked = matching.length > 0;
              return (
                <Button
                  key={label.id}
                  type="button"
                  variant="ghost"
                  className="w-full justify-start"
                  aria-pressed={checked}
                  disabled={search.busy || (!checked && groups.length >= 100)}
                  onClick={() => {
                    const values = checked
                      ? selected.filter((value) => !matching.includes(value))
                      : [...selected, labelGroupSelection(label)];
                    onChange(values.length ? values : null);
                  }}
                >
                  <span aria-hidden="true">{checked ? "✓" : "○"}</span>
                  <span className="truncate">{label.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {label.color}
                  </span>
                </Button>
              );
            })}
            {!search.catalogue.data?.items.length && (
              <p>
                {t("common:noMatchingLabels", {
                  defaultValue: "No matching labels",
                })}
              </p>
            )}
          </div>
        )}
        <LabelCataloguePager
          pagination={search.catalogue.data?.pagination}
          busy={search.busy}
          onPage={search.setPage}
        />
      </PopoverPopup>
    </Popover>
  );
}
