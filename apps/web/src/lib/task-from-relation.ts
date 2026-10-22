import type Task from "@/types/task";

type Snapshot = Pick<
  Task,
  | "id"
  | "version"
  | "title"
  | "number"
  | "status"
  | "priority"
  | "workItemType"
  | "userId"
  | "assigneeName"
  | "projectId"
>;

/** Preserve supplied revision and mark missing detail fields as summary data. */
export function taskFromRelation(task: Snapshot): Task {
  return {
    ...task,
    isSummary: true,
    description: null,
    startDate: null,
    dueDate: null,
    position: null,
    createdAt: "",
    updatedAt: "",
    assigneeId: task.userId,
    assigneeImage: "",
  };
}
