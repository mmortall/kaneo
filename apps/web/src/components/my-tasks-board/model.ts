import type { ProjectWithTasks } from "@/types/project";
import type Task from "@/types/task";
import type { TaskCategory, TaskHorizon } from "@/types/task";

export type MyTask = Task & {
  projectName: string;
  projectSlug: string;
};

export type MyTasksColumn = {
  icon: string | null;
  id: string;
  isFinal: boolean;
  name: string;
  tasks: MyTask[];
};

type MutableColumn = MyTasksColumn & {
  orderSamples: number[];
};

export function buildMyTasksColumns(
  projects: ProjectWithTasks[],
  statusOverrides: Record<string, string> = {},
  taskCategory?: TaskCategory,
  blockedColumnName = "Blocked",
  strategyHorizon?: TaskHorizon,
): MyTasksColumn[] {
  const columns = new Map<string, MutableColumn>();

  for (const project of projects) {
    project.columns.forEach((column, index) => {
      const existing = columns.get(column.id);
      if (existing) {
        existing.orderSamples.push(index);
        existing.isFinal ||= column.isFinal;
        return;
      }

      columns.set(column.id, {
        icon: column.icon ?? null,
        id: column.id,
        isFinal: column.isFinal,
        name: column.name,
        orderSamples: [index],
        tasks: [],
      });
    });
  }

  const hasBlockedTasks = projects.some(
    (project) => (project.blockedTasks?.length ?? 0) > 0,
  );
  if (hasBlockedTasks && !columns.has("blocked")) {
    columns.set("blocked", {
      icon: null,
      id: "blocked",
      isFinal: false,
      name: blockedColumnName,
      orderSamples: [
        Math.max(0, ...projects.map((project) => project.columns.length)),
      ],
      tasks: [],
    });
  }

  const seenTaskIds = new Set<string>();
  for (const project of projects) {
    const projectTasks = [
      ...project.columns.flatMap((column) => column.tasks),
      ...(project.blockedTasks ?? []),
    ];

    for (const task of projectTasks) {
      if (seenTaskIds.has(task.id)) continue;
      seenTaskIds.add(task.id);

      const category = task.taskCategory ?? "live_implementation";
      if (taskCategory && category !== taskCategory) continue;
      if (
        strategyHorizon &&
        !(task.strategyHorizons ?? []).includes(strategyHorizon)
      ) {
        continue;
      }
      const effectiveStatus = statusOverrides[task.id] ?? task.status;
      const targetColumn = columns.get(effectiveStatus);
      if (!targetColumn) continue;

      targetColumn.tasks.push({
        ...task,
        taskCategory: category,
        projectName: project.name,
        projectSlug: project.slug,
        status: effectiveStatus,
      });
    }
  }

  return [...columns.values()]
    .sort(
      (left, right) => average(left.orderSamples) - average(right.orderSamples),
    )
    .map(({ orderSamples: _orderSamples, ...column }) => ({
      ...column,
      tasks: column.tasks.sort(
        (left, right) => (left.position ?? 0) - (right.position ?? 0),
      ),
    }));
}

export function countMyTasks(
  projects: ProjectWithTasks[],
  strategyHorizon?: TaskHorizon,
) {
  return buildMyTasksColumns(
    projects,
    {},
    undefined,
    "Blocked",
    strategyHorizon,
  ).reduce((count, column) => count + column.tasks.length, 0);
}

export function findMyTask(
  projects: ProjectWithTasks[],
  taskId: string,
): Task | undefined {
  for (const project of projects) {
    const task = [
      ...project.columns.flatMap((column) => column.tasks),
      ...(project.blockedTasks ?? []),
    ].find((item) => item.id === taskId);
    if (task) return task;
  }
  return undefined;
}

export function countToDoByCategory(
  projects: ProjectWithTasks[],
  strategyHorizon?: TaskHorizon,
) {
  const counts: Record<TaskCategory, number> = {
    live_implementation: 0,
    research: 0,
    agent_blocker: 0,
  };

  for (const project of projects) {
    for (const column of project.columns) {
      if (column.id !== "to-do") continue;
      for (const task of column.tasks) {
        if (
          strategyHorizon &&
          !(task.strategyHorizons ?? []).includes(strategyHorizon)
        ) {
          continue;
        }
        counts[task.taskCategory ?? "live_implementation"] += 1;
      }
    }
  }

  return counts;
}

export function projectSupportsStatus(
  projects: ProjectWithTasks[],
  projectId: string,
  status: string,
) {
  return Boolean(
    status === "blocked" ||
      projects
        .find((project) => project.id === projectId)
        ?.columns.some((column) => column.id === status),
  );
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
