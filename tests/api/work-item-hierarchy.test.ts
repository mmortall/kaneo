import { describe, expect, it } from "vitest";
import { isAllowedParentChild } from "../../apps/api/src/task-relation/work-item-hierarchy";

describe("work item hierarchy", () => {
  it("allows declared Epic hierarchy", () => {
    expect(isAllowedParentChild("epic", "sub_epic")).toBe(true);
    expect(isAllowedParentChild("epic", "task")).toBe(true);
    expect(isAllowedParentChild("sub_epic", "task")).toBe(true);
  });

  it("rejects invalid parent-child combinations", () => {
    expect(isAllowedParentChild("task", "task")).toBe(false);
    expect(isAllowedParentChild("sub_epic", "epic")).toBe(false);
    expect(isAllowedParentChild("epic", "epic")).toBe(false);
  });
});
