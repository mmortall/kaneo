import { expect, it } from "vitest";
import type Task from "@/types/task";
import { taskDragOrder } from "./task-drag-order";

const task = (id: string, version: number) =>
  ({
    id,
    version,
    projectId: "project",
    description: "Keep prose",
    position: 500,
  }) as Task;
const sections = [
  { id: "to-do", tasks: [task("first", 7), task("later", 9)] },
  { id: "planned", tasks: [task("planned-task", 3)] },
];

it("uses anchor snapshots instead of renumbering a partial page", () => {
  expect(taskDragOrder(sections, "first", "later")).toEqual({
    task: { id: "first", version: 7, projectId: "project" },
    status: "to-do",
    anchor: {
      task: { id: "later", version: 9, projectId: "project" },
      placement: "after",
    },
  });
  expect(taskDragOrder(sections, "later", "first")?.anchor?.placement).toBe(
    "before",
  );
  expect(sections[0].tasks[0].position).toBe(500);
});
it("appends to entire destination on section drop and anchors cross-section drops", () => {
  expect(taskDragOrder(sections, "first", "planned")).not.toHaveProperty(
    "anchor",
  );
  expect(taskDragOrder(sections, "first", "planned-task")).toMatchObject({
    status: "planned",
    anchor: { task: { id: "planned-task", version: 3 }, placement: "after" },
  });
  expect(
    taskDragOrder(
      [...sections, { id: "archived", tasks: [] }],
      "first",
      "archived",
    ),
  ).not.toHaveProperty("anchor");
});
it("ignores self and targets outside current view", () => {
  expect(taskDragOrder(sections, "first", "first")).toBeUndefined();
  expect(taskDragOrder(sections, "first", "missing")).toBeUndefined();
});
