import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BoardFilters } from "@/hooks/use-task-filters";
import {
  labelGroupKey,
  labelGroupSelection,
  matchesLabelSelection,
} from "./label-filter-selection";
import { taskViewFilters } from "./task-view-filters";

const filters: BoardFilters = {
  status: null,
  priority: null,
  assignee: null,
  dueDate: null,
  labels: null,
};
describe("Task view filters", () => {
  it("preserves group intent and individual IDs without loading catalogue members", () => {
    const group = { id: "representative", name: "Bug", color: "red" };
    const result = taskViewFilters(
      {
        ...filters,
        labels: [labelGroupSelection(group), "one-old-assignment"],
      },
      "",
      1,
    );
    expect(result.labelGroups).toEqual([{ name: "Bug", color: "red" }]);
    expect(result.labels).toEqual(["one-old-assignment"]);
    expect(
      matchesLabelSelection(
        [labelGroupSelection(group)],
        [{ ...group, id: "other-assignment" }],
      ),
    ).toBe(true);
    expect(
      matchesLabelSelection(
        ["one-old-assignment"],
        [{ ...group, id: "other-assignment" }],
      ),
    ).toBe(false);
    expect(
      matchesLabelSelection(
        [labelGroupSelection(group)],
        [{ ...group, color: "blue" }],
      ),
    ).toBe(false);
  });
  it("uses stable bounded group key for existing names beyond descriptor limit", () => {
    const group = {
      id: "long-name-group",
      name: "x".repeat(257),
      color: "red",
    };
    const result = taskViewFilters(
      { ...filters, labels: [labelGroupSelection(group)] },
      "",
      1,
    );
    const expected = createHash("sha256")
      .update(group.name + "\0" + group.color)
      .digest("hex");
    expect(result.labelGroupKeys).toEqual([expected]);
    expect(result.labelGroups).toBeUndefined();
    expect(result.labels).toBeUndefined();
    expect(JSON.stringify(result).length).toBeLessThan(100);
    expect(
      taskViewFilters(
        {
          ...filters,
          labels: [labelGroupSelection({ ...group, id: "replacement" })],
        },
        "",
        1,
      ),
    ).toEqual(result);
  });
  it("hashes Unicode UTF8 and separates name/color boundaries", () => {
    const group = { name: "Метка😀", color: "蓝" };
    expect(labelGroupKey(group)).toBe(
      createHash("sha256")
        .update(group.name + "\0" + group.color)
        .digest("hex"),
    );
    expect(labelGroupKey({ name: "a", color: "bc" })).not.toBe(
      labelGroupKey({ name: "ab", color: "c" }),
    );
  });
  it("keeps empty assignee/priority and literal search selections", () => {
    expect(
      taskViewFilters(
        {
          ...filters,
          status: ["blocked", "planned"],
          assignee: [""],
          priority: [""],
          labels: ["label"],
        },
        " %_needle ",
        1,
      ),
    ).toMatchObject({
      statuses: ["blocked", "planned"],
      assignees: [""],
      priorities: [""],
      labels: ["label"],
      text: "%_needle",
    });
  });
  it.each([0, 1, 6] as const)(
    "preserves local week boundaries with weekStartsOn=%i",
    (weekStartsOn) => {
      const now = new Date(2026, 9, 8, 12);
      const result = taskViewFilters(
        { ...filters, dueDate: ["dueThisWeek", "dueNextWeek", "noDueDate"] },
        "",
        weekStartsOn,
        now,
      );
      expect(result.noDueDate).toBe(true);
      expect(result.dueRanges).toHaveLength(2);
      const days = { 0: [4, 10], 1: [5, 11], 6: [3, 9] };
      expect(result.dueRanges![0]).toEqual({
        start: new Date(2026, 9, days[weekStartsOn][0]).toISOString(),
        end: new Date(
          2026,
          9,
          days[weekStartsOn][1],
          23,
          59,
          59,
          999,
        ).toISOString(),
      });
      const firstEnd = new Date(result.dueRanges![0].end);
      const nextStart = new Date(result.dueRanges![1].start);
      expect(nextStart.getTime() - firstEnd.getTime()).toBe(1);
      expect(nextStart.getDay()).toBe(weekStartsOn);
      expect(nextStart.getHours()).toBe(0);
    },
  );
  it.runIf(process.env.TZ === "Europe/Kyiv")(
    "keeps local week during autumn DST transition",
    () => {
      const result = taskViewFilters(
        { ...filters, dueDate: ["dueThisWeek"] },
        "",
        1,
        new Date(2026, 9, 23, 12),
      );
      expect(result.dueRanges).toEqual([
        { start: "2026-10-18T21:00:00.000Z", end: "2026-10-25T21:59:59.999Z" },
      ]);
    },
  );
  it("does not create a date predicate for empty date selection", () => {
    const result = taskViewFilters(filters, " ", 1);
    expect(result.dueRanges).toBeUndefined();
    expect(result.noDueDate).toBeUndefined();
    expect(result.text).toBeUndefined();
  });
  it("compresses fully selected groups while retaining partial and unknown IDs", () => {
    const catalog = [
      { id: "a", name: "Bug", color: "red" },
      { id: "b", name: "Bug", color: "red" },
      { id: "c", name: "Bug", color: "blue" },
      { id: "d", name: "Bug", color: "blue" },
    ];
    const result = taskViewFilters(
      { ...filters, labels: ["a", "b", "c", "unknown"] },
      "",
      1,
      new Date(),
      catalog,
    );
    expect(result.labelGroups).toEqual([{ name: "Bug", color: "red" }]);
    expect(result.labels).toEqual(["c", "unknown"]);
  });
  it("represents a 20,000-ID group with one descriptor", () => {
    const catalog = Array.from({ length: 20_000 }, (_, i) => ({
      id: String(i),
      name: "Bug",
      color: "red",
    }));
    const result = taskViewFilters(
      { ...filters, labels: catalog.map((label) => label.id) },
      "",
      1,
      new Date(),
      catalog,
    );
    expect(result.labels).toBeUndefined();
    expect(result.labelGroups).toEqual([{ name: "Bug", color: "red" }]);
    expect(JSON.stringify(result).length).toBeLessThan(100);
  });
});
