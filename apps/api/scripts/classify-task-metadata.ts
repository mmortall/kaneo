import { and, eq } from "drizzle-orm";
import db, { getDatabasePool } from "../src/database";
import { taskTable } from "../src/database/schema";
import { classifyTaskMetadata } from "../src/task/classify-task-metadata";

const apply = process.argv.includes("--apply");
const assigneeId = getArgument("--assignee-id");

if (!assigneeId) {
  throw new Error("--assignee-id is required");
}

const tasks = await db
  .select({
    blockedReason: taskTable.blockedReason,
    id: taskTable.id,
    status: taskTable.status,
    strategyHorizons: taskTable.strategyHorizons,
    taskCategory: taskTable.taskCategory,
    title: taskTable.title,
  })
  .from(taskTable)
  .where(eq(taskTable.userId, assigneeId));

const changes = tasks.flatMap((task) => {
  const inferred = classifyTaskMetadata(task);
  const taskCategory =
    task.taskCategory === "live_implementation" &&
    inferred.taskCategory !== "live_implementation"
      ? inferred.taskCategory
      : task.taskCategory;
  const strategyHorizons =
    task.strategyHorizons.length === 0 && inferred.strategyHorizons.length > 0
      ? inferred.strategyHorizons
      : task.strategyHorizons;

  if (
    taskCategory === task.taskCategory &&
    arraysEqual(strategyHorizons, task.strategyHorizons)
  ) {
    return [];
  }

  return [{ ...task, strategyHorizons, taskCategory }];
});

const summary = {
  apply,
  assignedTasks: tasks.length,
  changedTasks: changes.length,
  categories: countBy(changes, (task) => task.taskCategory),
  horizons: countHorizons(changes),
  sample: changes.slice(0, 20).map((task) => ({
    id: task.id,
    strategyHorizons: task.strategyHorizons,
    taskCategory: task.taskCategory,
    title: task.title,
  })),
};

if (apply) {
  await db.transaction(async (transaction) => {
    for (const task of changes) {
      await transaction
        .update(taskTable)
        .set({
          strategyHorizons: task.strategyHorizons,
          taskCategory: task.taskCategory,
        })
        .where(
          and(eq(taskTable.id, task.id), eq(taskTable.userId, assigneeId)),
        );
    }
  });
}

console.log(JSON.stringify(summary, null, 2));
await getDatabasePool().end();

function getArgument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function arraysEqual(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function countBy<T>(items: T[], getKey: (item: T) => string) {
  return items.reduce<Record<string, number>>((counts, item) => {
    const key = getKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function countHorizons(items: typeof changes) {
  return items.reduce<Record<string, number>>((counts, task) => {
    for (const horizon of task.strategyHorizons) {
      counts[horizon] = (counts[horizon] ?? 0) + 1;
    }
    return counts;
  }, {});
}
