import { describe, expect, it } from "vitest";
import type { ProjectWithTasks } from "@/types/project";
import type Task from "@/types/task";
import {
  buildMyTasksColumns,
  countMyTasks,
  countToDoByCategory,
  projectSupportsStatus,
} from "./model";

const task = (overrides: Partial<Task>): Task => ({
  assigneeId: "user-1",
  assigneeName: "Ada",
  createdAt: "2026-01-01T00:00:00.000Z",
  description: null,
  dueDate: null,
  id: "task-1",
  number: 1,
  position: 0,
  priority: "medium",
  projectId: "project-1",
  startDate: null,
  status: "to-do",
  title: "First task",
  taskCategory: "live_implementation",
  userId: "user-1",
  ...overrides,
});

const project = (
  id: string,
  columns: ProjectWithTasks["columns"],
): ProjectWithTasks =>
  ({
    archivedTasks: [],
    blockedTasks: [],
    columns,
    description: "",
    icon: "Layout",
    id,
    isPublic: false,
    name: `Project ${id}`,
    plannedTasks: [],
    slug: id.toUpperCase(),
    workspaceId: "workspace-1",
  }) as ProjectWithTasks;

const column = (
  id: string,
  name: string,
  tasks: Task[],
  isFinal = false,
): ProjectWithTasks["columns"][number] =>
  ({
    id,
    slug: id,
    name,
    icon: null,
    isFinal,
    tasks,
  }) as ProjectWithTasks["columns"][number];

describe("my tasks board model", () => {
  it("merges matching statuses and keeps project context on every task", () => {
    const projects = [
      project("project-1", [column("to-do", "To Do", [task({})])]),
      project("project-2", [
        column("to-do", "To Do", [
          task({ id: "task-2", projectId: "project-2", title: "Second" }),
        ]),
      ]),
    ];

    const [toDo] = buildMyTasksColumns(projects);

    expect(toDo.tasks).toHaveLength(2);
    expect(toDo.tasks.map((item) => item.projectName)).toEqual([
      "Project project-1",
      "Project project-2",
    ]);
  });

  it("moves an optimistic task only when target status exists in its project", () => {
    const projects = [
      project("project-1", [
        column("to-do", "To Do", [task({})]),
        column("done", "Done", [], true),
      ]),
      project("project-2", [column("to-do", "To Do", [])]),
    ];

    const columns = buildMyTasksColumns(projects, { "task-1": "done" });

    expect(columns.find((item) => item.id === "to-do")?.tasks).toHaveLength(0);
    expect(columns.find((item) => item.id === "done")?.tasks[0].status).toBe(
      "done",
    );
    expect(projectSupportsStatus(projects, "project-1", "done")).toBe(true);
    expect(projectSupportsStatus(projects, "project-2", "done")).toBe(false);
  });

  it("filters categories and counts only tasks in To Do", () => {
    const projects = [
      project("project-1", [
        column("to-do", "To Do", [
          task({ id: "live" }),
          task({ id: "research", taskCategory: "research" }),
          task({ id: "blocker", taskCategory: "agent_blocker" }),
        ]),
        column("in-progress", "In Progress", [
          task({ id: "research-progress", taskCategory: "research" }),
        ]),
      ]),
    ];

    const researchColumns = buildMyTasksColumns(projects, {}, "research");

    expect(
      researchColumns.flatMap((item) => item.tasks).map((item) => item.id),
    ).toEqual(["research", "research-progress"]);
    expect(countToDoByCategory(projects)).toEqual({
      live_implementation: 1,
      research: 1,
      agent_blocker: 1,
    });
  });

  it("includes virtual blocked tasks and moves them optimistically", () => {
    const blockedTask = task({
      id: "human-access",
      status: "blocked",
      taskCategory: "agent_blocker",
    });
    const blockedProject = project("project-1", [
      column("to-do", "To Do", []),
      column("done", "Done", [], true),
    ]);
    blockedProject.blockedTasks = [blockedTask];

    const initial = buildMyTasksColumns([blockedProject], {}, "agent_blocker");
    const moved = buildMyTasksColumns(
      [blockedProject],
      { "human-access": "to-do" },
      "agent_blocker",
    );

    expect(initial.find((item) => item.id === "blocked")?.tasks).toEqual([
      expect.objectContaining({ id: "human-access", status: "blocked" }),
    ]);
    expect(moved.find((item) => item.id === "blocked")?.tasks).toHaveLength(0);
    expect(moved.find((item) => item.id === "to-do")?.tasks).toEqual([
      expect.objectContaining({ id: "human-access", status: "to-do" }),
    ]);
    expect(
      projectSupportsStatus([blockedProject], "project-1", "blocked"),
    ).toBe(true);
    expect(countToDoByCategory([blockedProject]).agent_blocker).toBe(0);
    expect(countMyTasks([blockedProject])).toBe(1);
  });

  it("filters tasks and To Do counts by strategy horizon", () => {
    const projects = [
      project("project-1", [
        column("to-do", "To Do", [
          task({ id: "short", strategyHorizons: ["short"] }),
          task({
            id: "position-research",
            taskCategory: "research",
            strategyHorizons: ["position", "long_term"],
          }),
          task({ id: "unclassified", strategyHorizons: [] }),
        ]),
      ]),
    ];

    const positionColumns = buildMyTasksColumns(
      projects,
      {},
      undefined,
      "Blocked",
      "position",
    );

    expect(positionColumns.flatMap((column) => column.tasks)).toEqual([
      expect.objectContaining({ id: "position-research" }),
    ]);
    expect(countMyTasks(projects, "position")).toBe(1);
    expect(countToDoByCategory(projects, "position")).toEqual({
      agent_blocker: 0,
      live_implementation: 0,
      research: 1,
    });
  });
});
