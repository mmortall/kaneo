import type { TaskOrderInput } from "@/fetchers/task/order-task";
import type Task from "@/types/task";

/** Convert visible drag target into intent; server resolves hidden neighbors. */
export function taskDragOrder(
  sections: ReadonlyArray<{ id: string; tasks: Task[] }>,
  activeId: string,
  overId: string,
): TaskOrderInput | undefined {
  if (activeId === overId) return;
  const source = sections.find((section) =>
    section.tasks.some((task) => task.id === activeId),
  );
  const target = sections.find(
    (section) =>
      section.id === overId || section.tasks.some((task) => task.id === overId),
  );
  const task = source?.tasks.find((task) => task.id === activeId);
  if (!task || !target || !source) return;
  const snapshot = (task: Task) => ({
    id: task.id,
    version: task.version,
    projectId: task.projectId,
  });
  const anchor = target.tasks.find((task) => task.id === overId);
  const placement =
    source.id === target.id &&
    source.tasks.findIndex((task) => task.id === activeId) >
      target.tasks.findIndex((task) => task.id === overId)
      ? "before"
      : "after";
  return {
    task: snapshot(task),
    status: target.id,
    ...(anchor ? { anchor: { task: snapshot(anchor), placement } } : {}),
  };
}
