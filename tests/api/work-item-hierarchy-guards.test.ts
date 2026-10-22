import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSelect = vi.fn();

vi.mock("../../apps/api/src/database", () => ({
  default: { select: (...args: unknown[]) => mockSelect(...args) },
}));

import {
  assertSubtaskRelationAllowed,
  assertWorkItemTypeChangeAllowed,
} from "../../apps/api/src/task-relation/work-item-hierarchy";

function rowsResult(rows: unknown[]) {
  return Object.assign(Promise.resolve(rows), {
    limit: vi.fn().mockResolvedValue(rows),
  });
}

function queueSelects(...results: unknown[][]) {
  mockSelect.mockImplementation(() => {
    const result = rowsResult(results.shift() ?? []);
    const chain = {
      from: vi.fn(() => chain),
      where: vi.fn(() => result),
    };
    return chain;
  });
}

const epic = { id: "epic", projectId: "project-1", workItemType: "epic" };
const subEpic = {
  id: "sub-epic",
  projectId: "project-1",
  workItemType: "sub_epic",
};
const task = { id: "task", projectId: "project-1", workItemType: "task" };

beforeEach(() => {
  mockSelect.mockReset();
});

describe("work item hierarchy guards", () => {
  it("rejects cross-project and invalid relations before querying database", async () => {
    await expect(
      assertSubtaskRelationAllowed(epic, { ...task, projectId: "project-2" }),
    ).rejects.toThrow("same project");
    await expect(assertSubtaskRelationAllowed(task, epic)).rejects.toThrow(
      "Allowed hierarchy",
    );
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("rejects a second parent for a hierarchy item", async () => {
    queueSelects([{ id: "existing-relation" }]);

    await expect(assertSubtaskRelationAllowed(epic, subEpic)).rejects.toThrow(
      "only one parent",
    );
  });

  it("rejects a relation that would create a cycle", async () => {
    queueSelects([], [{ sourceTaskId: subEpic.id }]);

    await expect(assertSubtaskRelationAllowed(epic, subEpic)).rejects.toThrow(
      "cannot create a cycle",
    );
  });

  it("accepts a valid hierarchy relation with no existing parent or ancestor", async () => {
    queueSelects([], []);

    await expect(
      assertSubtaskRelationAllowed(epic, subEpic),
    ).resolves.toBeUndefined();
  });

  it("rejects type changes that invalidate either child or parent relation", async () => {
    queueSelects(
      [{ sourceTaskId: "epic", targetTaskId: "child" }],
      [],
      [{ id: "child", workItemType: "sub_epic" }],
    );
    await expect(
      assertWorkItemTypeChangeAllowed("epic", "task"),
    ).rejects.toThrow("existing child");

    queueSelects(
      [],
      [{ sourceTaskId: "parent" }],
      [{ id: "parent", workItemType: "sub_epic" }],
    );
    await expect(
      assertWorkItemTypeChangeAllowed("child", "epic"),
    ).rejects.toThrow("its parent");
  });
});
