import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Task from "@/types/task";
import TaskMovePopover from "./task-move-popover";

const mocks = vi.hoisted(() => ({
  columns: vi.fn(),
  tasks: vi.fn(),
  move: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/queries/project/use-get-projects", () => ({
  default: () => ({
    data: [
      { id: "source", name: "Source" },
      { id: "destination", name: "Destination" },
    ],
  }),
}));
vi.mock("@/hooks/queries/column/use-get-columns", () => ({
  useGetColumns: (id: string) => mocks.columns(id),
}));
vi.mock("@/hooks/queries/task/use-get-tasks", () => ({
  useGetTasks: (id: string) => mocks.tasks(id),
}));
vi.mock("@/hooks/mutations/task/use-move-task", () => ({
  useMoveTask: () => ({ mutateAsync: mocks.move, isPending: false }),
}));
// Native controls isolate request selection from overlay implementation.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: () => null,
  PopoverContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
    disabled,
  }: {
    children: ReactNode;
    value?: string;
    onValueChange: (value: string) => void;
    disabled?: boolean;
  }) => (
    <select
      aria-label="choice"
      value={value ?? ""}
      onChange={(e) => onValueChange(e.target.value)}
      disabled={disabled}
    >
      <option value="" />
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}));

const task: Task = {
  id: "task",
  projectId: "source",
  version: 7,
  title: "Move",
  number: 1,
  description: null,
  status: "source-column",
  priority: null,
  startDate: null,
  dueDate: null,
  position: 1,
  createdAt: "2026-10-08T00:00:00Z",
  userId: null,
  assigneeId: null,
  assigneeName: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tasks.mockImplementation(() => {
    throw new Error("Full task listing is forbidden for move destination");
  });
  mocks.columns.mockImplementation((id) => ({
    data: id
      ? [{ id: "column-row-id", slug: "destination-column", name: "Ready" }]
      : undefined,
    isLoading: false,
    isError: false,
  }));
  mocks.move.mockResolvedValue({
    task: { ...task, projectId: "destination", version: 8 },
  });
});
afterEach(cleanup);

describe("Move destination metadata", () => {
  it("loads only columns and preserves caller revision on move", async () => {
    render(<TaskMovePopover task={task} workspaceId="workspace" />);
    fireEvent.change(screen.getAllByRole("combobox")[0], {
      target: { value: "destination" },
    });
    await waitFor(() =>
      expect(mocks.columns).toHaveBeenCalledWith("destination"),
    );
    expect(mocks.tasks).not.toHaveBeenCalled();
    expect(screen.getByRole("option", { name: "Ready" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "tasks:move.action" }));
    await waitFor(() =>
      expect(mocks.move).toHaveBeenCalledWith({
        taskId: "task",
        destinationProjectId: "destination",
        destinationStatus: "destination-column",
        expectedVersion: 7,
      }),
    );
  });

  it.each(["loading", "error"])(
    "prevents move while columns report %s",
    (state) => {
      mocks.columns.mockImplementation((id) => ({
        data: undefined,
        isLoading: !!id && state === "loading",
        isError: !!id && state === "error",
      }));
      render(<TaskMovePopover task={task} workspaceId="workspace" />);
      fireEvent.change(screen.getAllByRole("combobox")[0], {
        target: { value: "destination" },
      });
      expect(
        screen.getByRole("button", { name: "tasks:move.action" }),
      ).toBeDisabled();
      expect(mocks.tasks).not.toHaveBeenCalled();
      expect(mocks.move).not.toHaveBeenCalled();
    },
  );
});
