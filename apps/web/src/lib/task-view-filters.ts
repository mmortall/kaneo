import { addWeeks, endOfWeek, startOfWeek } from "date-fns";
import type { TaskViewRequest } from "@/fetchers/task/get-task-view";
import {
  type BoardFilters,
  DUE_DATE_FILTER_VALUES,
} from "@/hooks/use-task-filters";
import {
  labelGroupKey,
  parseLabelGroupSelection,
} from "./label-filter-selection";

/** Translate user-local week boundaries once; API compares explicit UTC ranges. */
export function taskViewFilters(
  filters: BoardFilters,
  text: string,
  weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6,
  now = new Date(),
  completeLabelCatalog?: ReadonlyArray<{
    id: string;
    name: string;
    color: string;
  }>,
): NonNullable<TaskViewRequest["filters"]> {
  const dueRanges = (filters.dueDate ?? []).flatMap((value) => {
    const date =
      value === DUE_DATE_FILTER_VALUES.dueThisWeek
        ? now
        : value === DUE_DATE_FILTER_VALUES.dueNextWeek
          ? addWeeks(now, 1)
          : undefined;
    return date
      ? [
          {
            start: startOfWeek(date, { weekStartsOn }).toISOString(),
            end: endOfWeek(date, { weekStartsOn }).toISOString(),
          },
        ]
      : [];
  });
  const selected = new Set(filters.labels ?? []);
  const labelGroups: Array<{ name: string; color: string }> = [];
  const labelGroupKeys: string[] = [];
  for (const value of selected) {
    const group = parseLabelGroupSelection(value);
    if (!group) continue;
    selected.delete(value);
    if (group.name.length <= 256 && group.color.length <= 64) {
      if (
        !labelGroups.some(
          (item) => item.name === group.name && item.color === group.color,
        )
      )
        labelGroups.push({ name: group.name, color: group.color });
    } else {
      const key = labelGroupKey(group);
      if (!labelGroupKeys.includes(key)) labelGroupKeys.push(key);
    }
  }
  if (selected.size && completeLabelCatalog) {
    const groups = new Map<
      string,
      Array<{ id: string; name: string; color: string }>
    >();
    for (const label of completeLabelCatalog) {
      const key = JSON.stringify([label.name, label.color]);
      const group = groups.get(key) ?? [];
      group.push(label);
      groups.set(key, group);
    }
    for (const members of groups.values()) {
      if (
        labelGroups.length < 100 &&
        members[0].name.length <= 256 &&
        members[0].color.length <= 64 &&
        members.every((label) => selected.has(label.id))
      ) {
        labelGroups.push({ name: members[0].name, color: members[0].color });
        for (const label of members) selected.delete(label.id);
      }
    }
  }
  return {
    statuses: filters.status ?? undefined,
    priorities: filters.priority ?? undefined,
    assignees: filters.assignee ?? undefined,
    labels: selected.size ? [...selected] : undefined,
    labelGroups: labelGroups.length ? labelGroups : undefined,
    labelGroupKeys: labelGroupKeys.length ? labelGroupKeys : undefined,
    text: text.trim() || undefined,
    dueRanges: dueRanges.length ? dueRanges : undefined,
    noDueDate:
      filters.dueDate?.includes(DUE_DATE_FILTER_VALUES.noDueDate) || undefined,
  };
}
