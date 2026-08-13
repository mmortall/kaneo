import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindFirst = vi.fn();
const mockSelect = vi.fn();

vi.mock("../../../apps/api/src/database", () => ({
  default: {
    query: { taskTable: { findFirst: (...args: unknown[]) => mockFindFirst(...args) } },
    select: (...args: unknown[]) => mockSelect(...args),
  },
}));

vi.mock("../../../apps/api/src/events", () => ({ publishEvent: vi.fn() }));

import moveTask from "../../../apps/api/src/task/controllers/move-task";

beforeEach(() => {
  mockFindFirst.mockReset();
  mockSelect.mockReset();
});

describe("moveTask hierarchy guard", () => {
  it("requires a hierarchy relation to be removed before moving either endpoint", async () => {
    mockFindFirst.mockResolvedValue({
      id: "epic-1",
      projectId: "project-1",
      status: "to-do",
    });
    const relation = Object.assign(Promise.resolve([{ id: "relation-1" }]), {
      limit: vi.fn().mockResolvedValue([{ id: "relation-1" }]),
    });
    const chain: Record<string, unknown> = {
      from: vi.fn(() => chain),
      where: vi.fn(() => relation),
    };
    mockSelect.mockReturnValue(chain);

    await expect(
      moveTask({
        taskId: "epic-1",
        destinationProjectId: "project-2",
        currentUserId: "user-1",
      }),
    ).rejects.toThrow("Remove the hierarchy relation");
  });
});
