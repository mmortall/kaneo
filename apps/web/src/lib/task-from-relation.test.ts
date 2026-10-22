import { expect, it } from "vitest";
import { taskFromRelation } from "./task-from-relation";

it("preserves revision and hierarchy from a related task snapshot", () => {
  const input = {
    id: "child",
    version: 9,
    title: "Child",
    number: 1,
    status: "planned",
    priority: null,
    workItemType: "sub_epic",
    userId: "user",
    assigneeName: "Name",
    projectId: "project",
  };
  const task = taskFromRelation(input);
  expect(task).toMatchObject({
    ...input,
    isSummary: true,
    description: null,
    assigneeId: "user",
  });
  input.version = 10;
  expect(task.version).toBe(9);
});
