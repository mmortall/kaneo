import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { addDays } from "date-fns";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type Task from "@/types/task";

const mocks = vi.hoisted(() => ({
  patch: vi.fn(),
  legacy: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/hooks/mutations/task/use-update-task-fields", () => ({
  useUpdateTaskFields: () => ({ mutateAsync: mocks.patch }),
}));
vi.mock("@/hooks/mutations/task/use-update-task", () => ({
  useUpdateTask: () => ({ mutateAsync: mocks.legacy }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/toast", () => ({ toast: { error: mocks.error } }));

import { GanttTaskBar } from "./gantt-task-bar";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("PointerEvent", MouseEvent);
  mocks.patch.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const start = new Date(2026, 9, 10);
const task = {
  id: "scheduled",
  projectId: "project",
  version: 7,
  title: "Summary task",
  isSummary: true,
  description: null,
  status: "to-do",
  scheduleStart: start,
  scheduleEnd: addDays(start, 2),
} as unknown as Task & { scheduleStart: Date; scheduleEnd: Date };
function view() {
  render(
    <GanttTaskBar
      task={task}
      timeline={{
        days: Array.from({ length: 20 }, (_, i) => addDays(start, i)),
        rangeStart: start,
        gridTemplateColumns: "repeat(20, 44px)",
      }}
      pixelsPerDay={44}
      onOpenTask={() => {}}
    />,
  );
}
it("moves summary task with one revision-checked sparse date edit", async () => {
  view();
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "tasks:gantt.taskAriaLabel" }),
    { button: 0, clientX: 100 },
  );
  fireEvent.pointerUp(window, { clientX: 144 });
  await waitFor(() => expect(mocks.patch).toHaveBeenCalledOnce());
  expect(mocks.patch).toHaveBeenCalledWith({
    task: { id: "scheduled", projectId: "project", version: 7 },
    fields: {
      startDate: addDays(start, 1).toISOString(),
      dueDate: addDays(start, 3).toISOString(),
    },
  });
  expect(mocks.legacy).not.toHaveBeenCalled();
});
it("reports conflict without replaying mutation", async () => {
  mocks.patch.mockRejectedValue(new Error("Task changed"));
  view();
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "tasks:gantt.resizeDue" }),
    { button: 0, clientX: 100 },
  );
  fireEvent.pointerUp(window, { clientX: 144 });
  await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("Task changed"));
  expect(mocks.patch).toHaveBeenCalledOnce();
  expect(mocks.legacy).not.toHaveBeenCalled();
});
