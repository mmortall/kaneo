import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import useBacklogBulkSelectionStore from "@/store/backlog-bulk-selection";
import type { ProjectWithTasks } from "@/types/project";
import type Task from "@/types/task";
import BacklogListView from "../backlog-list-view";
import ListView from "../list-view";
import KanbanBoard from "./index";

const mocks = vi.hoisted(() => ({ order: vi.fn(), legacy: vi.fn() }));
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({
    children,
    onDragEnd,
  }: {
    children: ReactNode;
    onDragEnd: (event: object) => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() =>
          onDragEnd({ active: { id: "first" }, over: { id: "later" } })
        }
      >
        Drop task
      </button>
      {children}
    </div>
  ),
  DragOverlay: ({ children }: { children: ReactNode }) => children,
  closestCorners: vi.fn(),
  defaultDropAnimationSideEffects: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(),
  useDroppable: () => ({ setNodeRef: vi.fn() }),
  KeyboardSensor: vi.fn(),
  MouseSensor: vi.fn(),
  TouchSensor: vi.fn(),
}));
vi.mock("@dnd-kit/modifiers", () => ({ snapCenterToCursor: vi.fn() }));
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: ReactNode }) => children,
  verticalListSortingStrategy: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/i18n", () => ({ i18n: { t: (key: string) => key } }));
vi.mock("@/hooks/use-keyboard-shortcuts", () => ({
  useRegisterShortcuts: vi.fn(),
}));
vi.mock("@/hooks/mutations/task/use-order-task", () => ({
  useOrderTask: () => ({ mutate: mocks.order, isPending: false }),
}));
vi.mock("@/hooks/mutations/task/use-update-task-fields", () => ({
  useUpdateTaskFields: () => ({ mutate: mocks.legacy }),
}));
vi.mock("@/hooks/mutations/task/use-update-task", () => ({
  useUpdateTask: () => ({ mutate: mocks.legacy }),
}));
vi.mock("./column", () => ({ default: () => null }));
vi.mock("./task-card", () => ({ default: () => null }));
vi.mock("../list-view/task-row", () => ({ default: () => null }));
vi.mock("../backlog-list-view/backlog-task-row", () => ({
  default: () => null,
}));
vi.mock("../bulk-selection/bulk-toolbar", () => ({ default: () => null }));
vi.mock("../bulk-selection/backlog-bulk-toolbar", () => ({
  default: () => null,
}));
vi.mock("../shared/modals/create-task-modal", () => ({ default: () => null }));
vi.mock("../shared/modals/archive-tasks-modal", () => ({
  ArchiveTasksModal: () => null,
}));

const task = (id: string, version: number) =>
  ({
    id,
    version,
    projectId: "project",
    status: "to-do",
    position: 1000,
  }) as Task;
const tasks = [task("first", 7), task("later", 9)];
const project = {
  id: "project",
  workspaceId: "workspace",
  name: "Project",
  columns: [{ id: "to-do", name: "To Do", isFinal: false, tasks }],
  archivedTasks: [],
  plannedTasks: [],
  blockedTasks: [],
} as unknown as ProjectWithTasks;
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

it.each([KanbanBoard, ListView, BacklogListView])(
  "submits one order intent instead of writing every visible neighbor",
  (Component) => {
    const isBacklog = Component === BacklogListView;
    const data = isBacklog
      ? {
          ...project,
          columns: [],
          plannedTasks: tasks.map((task) => ({ ...task, status: "planned" })),
        }
      : project;
    render(<Component project={data} />);
    fireEvent.click(screen.getByRole("button", { name: "Drop task" }));
    expect(mocks.order).toHaveBeenCalledTimes(1);
    expect(mocks.order).toHaveBeenCalledWith({
      task: { id: "first", version: 7, projectId: "project" },
      status: isBacklog ? "planned" : "to-do",
      anchor: {
        task: { id: "later", version: 9, projectId: "project" },
        placement: "after",
      },
    });
    expect(mocks.legacy).not.toHaveBeenCalled();
    expect(tasks[0].position).toBe(1000);
  },
);

it("backlog shows complete selected-section count while selection includes only loaded rows", () => {
  const data = {
    ...project,
    countsByStatus: { archived: 10000 },
    archivedTasks: tasks,
    plannedTasks: [],
  } as ProjectWithTasks;
  render(<BacklogListView project={data} sections={["archived"]} />);
  expect(screen.getByText("10000")).toBeInTheDocument();
  expect(
    screen.queryByText("tasks:backlog.sections.planned"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("tasks:backlog.sections.blocked"),
  ).not.toBeInTheDocument();
  expect(useBacklogBulkSelectionStore.getState().availableTaskIds).toEqual(
    tasks.map((task) => task.id),
  );
});

it("backlog distinguishes empty page from empty complete section", () => {
  const data = {
    ...project,
    countsByStatus: { archived: 23 },
    archivedTasks: [],
  } as ProjectWithTasks;
  render(<BacklogListView project={data} sections={["archived"]} />);
  expect(screen.getByText("23")).toBeInTheDocument();
  expect(screen.getByText("No tasks on this page.")).toBeInTheDocument();
});

it("list retains full final-column count and archive action when this page has no final tasks", () => {
  const data = {
    ...project,
    countsByStatus: { done: 10000 },
    columns: [{ id: "done", name: "Done", isFinal: true, tasks: [] }],
  } as unknown as ProjectWithTasks;
  render(<ListView project={data} />);
  expect(screen.getByText("10000")).toBeInTheDocument();
  expect(screen.getByText("No tasks on this page.")).toBeInTheDocument();
  expect(
    screen.getByTitle("tasks:listView.archiveAllTooltip"),
  ).toBeInTheDocument();
});
