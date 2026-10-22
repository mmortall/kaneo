import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  addLabelToTaskInTasksCache,
  removeLabelFromTaskInTasksCache,
  updateTaskLabelsInProject,
} from "./sync-task-labels-cache";

it("preserves workspace and paged cache shapes during legacy label updates", () => {
  const client = new QueryClient();
  const workspaceKey = ["tasks", "my", "workspace", "user"];
  const pageKey = ["tasks", "project", "view", { page: 2 }];
  const workspace = {
    projects: [],
    pagination: { page: 1 },
    counts: { total: 0 },
  };
  const page = {
    data: { columns: [], plannedTasks: [], archivedTasks: [] },
    pagination: { page: 2 },
  };
  client.setQueryData(workspaceKey, workspace);
  client.setQueryData(pageKey, page);
  addLabelToTaskInTasksCache(client, "task", {
    id: "label",
    name: "Label",
    color: "blue",
  });
  removeLabelFromTaskInTasksCache(client, "task", "label");
  expect(client.getQueryData(workspaceKey)).toBe(workspace);
  expect(client.getQueryData(pageKey)).toBe(page);
  client.clear();
});

describe("updateTaskLabelsInProject", () => {
  it("adds a label to the matching task without changing other tasks", () => {
    const project = {
      id: "project-1",
      name: "Project",
      slug: "PROJ",
      icon: null,
      description: null,
      isPublic: false,
      createdAt: "2026-04-16T00:00:00.000Z",
      updatedAt: "2026-04-16T00:00:00.000Z",
      workspaceId: "workspace-1",
      columns: [
        {
          id: "todo",
          slug: "todo",
          name: "Todo",
          icon: null,
          isFinal: false,
          tasks: [
            {
              id: "task-1",
              title: "Task 1",
              number: 1,
              description: null,
              status: "todo",
              priority: null,
              startDate: null,
              dueDate: null,
              position: 0,
              createdAt: "2026-04-16T00:00:00.000Z",
              updatedAt: "2026-04-16T00:00:00.000Z",
              userId: null,
              assigneeId: null,
              assigneeName: null,
              assigneeImage: null,
              projectId: "project-1",
              labels: [],
              externalLinks: [],
            },
            {
              id: "task-2",
              title: "Task 2",
              number: 2,
              description: null,
              status: "todo",
              priority: null,
              startDate: null,
              dueDate: null,
              position: 1,
              createdAt: "2026-04-16T00:00:00.000Z",
              updatedAt: "2026-04-16T00:00:00.000Z",
              userId: null,
              assigneeId: null,
              assigneeName: null,
              assigneeImage: null,
              projectId: "project-1",
              labels: [],
              externalLinks: [],
            },
          ],
        },
      ],
      plannedTasks: [],
      archivedTasks: [],
    };

    const updatedProject = updateTaskLabelsInProject(
      project,
      "task-1",
      (labels) => [
        ...labels,
        {
          id: "label-bug",
          name: "bug",
          color: "red",
        },
      ],
    );

    expect(updatedProject.columns[0]?.tasks[0]?.labels).toEqual([
      {
        id: "label-bug",
        name: "bug",
        color: "red",
      },
    ]);
    expect(updatedProject.columns[0]?.tasks[1]?.labels).toEqual([]);
  });

  it("removes a label from planned and archived task collections too", () => {
    const project = {
      id: "project-1",
      name: "Project",
      slug: "PROJ",
      icon: null,
      description: null,
      isPublic: false,
      createdAt: "2026-04-16T00:00:00.000Z",
      updatedAt: "2026-04-16T00:00:00.000Z",
      workspaceId: "workspace-1",
      columns: [],
      plannedTasks: [
        {
          id: "task-3",
          title: "Planned task",
          number: 3,
          description: null,
          status: "planned",
          priority: null,
          startDate: null,
          dueDate: null,
          position: 0,
          createdAt: "2026-04-16T00:00:00.000Z",
          updatedAt: "2026-04-16T00:00:00.000Z",
          userId: null,
          assigneeId: null,
          assigneeName: null,
          assigneeImage: null,
          projectId: "project-1",
          labels: [
            {
              id: "label-bug",
              name: "bug",
              color: "red",
            },
          ],
          externalLinks: [],
        },
      ],
      archivedTasks: [
        {
          id: "task-4",
          title: "Archived task",
          number: 4,
          description: null,
          status: "archived",
          priority: null,
          startDate: null,
          dueDate: null,
          position: 0,
          createdAt: "2026-04-16T00:00:00.000Z",
          updatedAt: "2026-04-16T00:00:00.000Z",
          userId: null,
          assigneeId: null,
          assigneeName: null,
          assigneeImage: null,
          projectId: "project-1",
          labels: [
            {
              id: "label-bug",
              name: "bug",
              color: "red",
            },
          ],
          externalLinks: [],
        },
      ],
    };

    const updatedProject = updateTaskLabelsInProject(
      project,
      "task-3",
      (labels) => labels.filter((label) => label.id !== "label-bug"),
    );

    expect(updatedProject.plannedTasks[0]?.labels).toEqual([]);
    expect(updatedProject.archivedTasks[0]?.labels).toEqual([
      {
        id: "label-bug",
        name: "bug",
        color: "red",
      },
    ]);
  });
});
