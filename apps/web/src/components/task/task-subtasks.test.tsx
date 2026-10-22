import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskSubtasks from "./task-subtasks";

const mocks = vi.hoisted(() => ({
  createTask: vi.fn(),
  createRelation: vi.fn(),
  getColumns: vi.fn(),
  relations: vi.fn(),
  updateStatus: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: unknown }) => children,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/mutations/task/use-create-task", () => ({
  default: () => ({ mutateAsync: mocks.createTask, isPending: false }),
}));
vi.mock("@/hooks/mutations/task-relation/use-create-task-relation", () => ({
  default: () => ({ mutateAsync: mocks.createRelation }),
}));
vi.mock("@/hooks/mutations/task/use-delete-task", () => ({
  useDeleteTask: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/mutations/task/use-update-task-status", () => ({
  useUpdateTaskStatus: () => ({ mutateAsync: mocks.updateStatus }),
}));
vi.mock("@/hooks/queries/column/use-get-columns", () => ({
  useGetColumns: () => mocks.getColumns(),
}));
vi.mock("@/hooks/queries/task-relation/use-get-task-relations", () => ({
  default: () => ({ data: mocks.relations() }),
}));
vi.mock("./subtask-row", () => ({
  default: ({ onToggleComplete }: { onToggleComplete: () => void }) => (
    <button type="button" onClick={onToggleComplete}>
      Complete child
    </button>
  ),
}));
vi.mock("@/hooks/queries/workspace/use-active-workspace", () => ({
  default: () => ({ data: { id: "workspace-1" } }),
}));
vi.mock(
  "@/hooks/queries/workspace-users/use-get-active-workspace-users",
  () => ({
    useGetActiveWorkspaceUsers: () => ({ data: { members: [] } }),
  }),
);
vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({ canManageTasks: () => true }),
}));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

beforeEach(() => {
  mocks.relations.mockReturnValue([]);
  mocks.updateStatus.mockResolvedValue({});
  mocks.getColumns.mockReturnValue({
    data: [
      { id: "todo", slug: "to-do", name: "To Do", isFinal: false },
      { id: "done", slug: "done", name: "Done", isFinal: true },
    ],
    isLoading: false,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TaskSubtasks", () => {
  it("passes relation snapshot revision to completion mutation", async () => {
    mocks.relations.mockReturnValue([
      {
        id: "relation",
        relationType: "subtask",
        sourceTaskId: "parent",
        targetTaskId: "child",
        targetTask: {
          id: "child",
          version: 9,
          title: "Child",
          number: 2,
          status: "to-do",
          priority: "low",
          workItemType: "task",
          userId: null,
          assigneeName: null,
          projectId: "project-1",
        },
      },
    ]);
    render(
      <TaskSubtasks
        taskId="parent"
        projectId="project-1"
        workspaceId="workspace-1"
        parentStatus="to-do"
        parentWorkItemType="sub_epic"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Complete child" }));
    await waitFor(() =>
      expect(mocks.updateStatus).toHaveBeenCalledWith(
        expect.objectContaining({ id: "child", version: 9, status: "done" }),
      ),
    );
  });
  it("creates a subtask as planned when its parent is planned", async () => {
    mocks.createTask.mockResolvedValue({ id: "subtask-1" });
    mocks.createRelation.mockResolvedValue({});

    render(
      <TaskSubtasks
        taskId="parent-1"
        projectId="project-1"
        workspaceId="workspace-1"
        parentStatus="planned"
        parentWorkItemType="epic"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "tasks:subtasks.addAction tasks:subtasks.title",
      }),
    );
    fireEvent.change(
      screen.getByPlaceholderText("tasks:subtasks.inputPlaceholder"),
      { target: { value: "Design login form" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "tasks:subtasks.addAction" }),
    );

    await waitFor(() => expect(mocks.createTask).toHaveBeenCalledTimes(1));
    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ status: "planned", workItemType: "sub_epic" }),
    );
  });

  it("uses the project's first active column for an active parent", async () => {
    mocks.createTask.mockResolvedValue({ id: "subtask-2" });
    mocks.createRelation.mockResolvedValue({});

    render(
      <TaskSubtasks
        taskId="parent-2"
        projectId="project-1"
        workspaceId="workspace-1"
        parentStatus="in-progress"
        parentWorkItemType="sub_epic"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "tasks:subtasks.addAction tasks:subtasks.title",
      }),
    );
    fireEvent.change(
      screen.getByPlaceholderText("tasks:subtasks.inputPlaceholder"),
      { target: { value: "Implement login form" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "tasks:subtasks.addAction" }),
    );

    await waitFor(() => expect(mocks.createTask).toHaveBeenCalledTimes(1));
    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ status: "to-do", workItemType: "task" }),
    );
  });

  it("blocks active-parent creation until project columns are available", () => {
    mocks.getColumns.mockReturnValue({ data: [], isLoading: true });

    render(
      <TaskSubtasks
        taskId="parent-3"
        projectId="project-1"
        workspaceId="workspace-1"
        parentStatus="in-progress"
        parentWorkItemType="epic"
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "tasks:subtasks.addAction tasks:subtasks.title",
      }),
    ).toBeDisabled();
  });

  it("does not allow an ordinary task to create hierarchy children", () => {
    render(
      <TaskSubtasks
        taskId="parent-4"
        projectId="project-1"
        workspaceId="workspace-1"
        parentStatus="in-progress"
        parentWorkItemType="task"
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "tasks:subtasks.addAction tasks:subtasks.title",
      }),
    ).toBeDisabled();
  });
});
