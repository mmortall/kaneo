import {
  and,
  eq,
  inArray,
  isNull,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import * as v from "valibot";
import { labelTable, taskTable } from "../database/schema";

const choices = v.pipe(
  v.array(v.pipe(v.string(), v.maxLength(128))),
  v.maxLength(100),
);
const dateRange = v.pipe(
  v.object({
    start: v.pipe(v.string(), v.isoTimestamp()),
    end: v.pipe(v.string(), v.isoTimestamp()),
  }),
  v.check(
    (range) => new Date(range.start).getTime() <= new Date(range.end).getTime(),
    "Date range must be increasing",
  ),
);

export const taskViewFilterSchema = v.object({
  statuses: v.optional(choices),
  excludeStatuses: v.optional(choices),
  priorities: v.optional(choices),
  assignees: v.optional(choices),
  labels: v.optional(
    v.pipe(v.array(v.pipe(v.string(), v.maxLength(128))), v.maxLength(20_000)),
  ),
  labelGroups: v.optional(
    v.pipe(
      v.array(
        v.object({
          name: v.pipe(v.string(), v.maxLength(256)),
          color: v.pipe(v.string(), v.maxLength(64)),
        }),
      ),
      v.maxLength(100),
    ),
  ),
  labelGroupIds: v.optional(choices),
  labelGroupKeys: v.optional(
    v.pipe(
      v.array(v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))),
      v.maxLength(100),
    ),
  ),
  dueRanges: v.optional(v.pipe(v.array(dateRange), v.maxLength(3))),
  noDueDate: v.optional(v.boolean()),
  scheduledOnly: v.optional(v.boolean()),
  searchStatus: v.optional(v.boolean()),
  text: v.optional(v.pipe(v.string(), v.maxLength(512))),
});

export type TaskViewFilter = v.InferOutput<typeof taskViewFilterSchema>;

/** Build complete view predicates before pagination; empty selections mean no filter. */
export function taskViewConditions(
  filter: TaskViewFilter,
  slug: string,
): SQL[] {
  const conditions: SQL[] = [];
  if (filter.statuses?.length)
    conditions.push(inArray(taskTable.status, filter.statuses));
  if (filter.excludeStatuses?.length)
    conditions.push(notInArray(taskTable.status, filter.excludeStatuses));
  if (filter.priorities?.length) {
    const assigned = filter.priorities.filter((value) => value !== "");
    conditions.push(
      or(
        assigned.length ? inArray(taskTable.priority, assigned) : undefined,
        filter.priorities.includes("") ? isNull(taskTable.priority) : undefined,
      )!,
    );
  }
  if (filter.assignees?.length) {
    const assigned = filter.assignees.filter((value) => value !== "");
    conditions.push(
      or(
        assigned.length ? inArray(taskTable.userId, assigned) : undefined,
        filter.assignees.includes("") ? isNull(taskTable.userId) : undefined,
      )!,
    );
  }
  if (
    filter.labels?.length ||
    filter.labelGroups?.length ||
    filter.labelGroupIds?.length ||
    filter.labelGroupKeys?.length
  ) {
    const labels = or(
      filter.labels?.length ? inArray(labelTable.id, filter.labels) : undefined,
      ...(filter.labelGroups ?? []).map((group) =>
        and(eq(labelTable.name, group.name), eq(labelTable.color, group.color)),
      ),
      filter.labelGroupKeys?.length
        ? inArray(
            sql<string>`encode(sha256(convert_to(${labelTable.name}, 'UTF8') || decode('00', 'hex') || convert_to(${labelTable.color}, 'UTF8')), 'hex')`,
            filter.labelGroupKeys,
          )
        : undefined,
      filter.labelGroupIds?.length
        ? sql`EXISTS (SELECT 1 FROM label AS selected_group
            WHERE selected_group.id IN (${sql.join(
              filter.labelGroupIds.map((id) => sql`${id}`),
              sql`, `,
            )})
              AND selected_group.workspace_id = ${labelTable.workspaceId}
              AND selected_group.name = ${labelTable.name}
              AND selected_group.color = ${labelTable.color})`
        : undefined,
    );
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${labelTable} WHERE ${eq(labelTable.taskId, taskTable.id)} AND ${labels})`,
    );
  }
  const due: SQL[] = (filter.dueRanges ?? []).map(
    (range) =>
      sql`${taskTable.dueDate} >= (${range.start}::timestamptz AT TIME ZONE 'UTC') AND ${taskTable.dueDate} <= (${range.end}::timestamptz AT TIME ZONE 'UTC')`,
  );
  if (filter.noDueDate) due.push(isNull(taskTable.dueDate));
  if (due.length) conditions.push(or(...due)!);
  if (filter.scheduledOnly)
    conditions.push(
      sql`(${taskTable.startDate} IS NOT NULL OR ${taskTable.dueDate} IS NOT NULL)`,
    );
  const text = filter.text?.trim().toLowerCase();
  if (text) {
    conditions.push(
      or(
        filter.searchStatus
          ? sql`strpos(lower(${taskTable.status}), ${text}) > 0`
          : undefined,
        sql`strpos(lower(coalesce(${taskTable.title}, '')), ${text}) > 0`,
        sql`strpos(lower(coalesce(${taskTable.description}, '')), ${text}) > 0`,
        and(
          sql`${taskTable.number} IS NOT NULL`,
          or(
            sql`strpos(${taskTable.number}::text, ${text}) > 0`,
            sql`left(lower(${slug} || '-' || ${taskTable.number}::text), length(${text})) = ${text}`,
            sql`left('#' || ${taskTable.number}::text, length(${text})) = ${text}`,
          ),
        ),
      )!,
    );
  }
  return conditions;
}
