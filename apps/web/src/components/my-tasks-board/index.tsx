import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { ListChecks } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useUpdateTaskStatus } from "@/hooks/mutations/task/use-update-task-status";
import { toast } from "@/lib/toast";
import type { ProjectWithTasks } from "@/types/project";
import type { TaskCategory, TaskHorizon } from "@/types/task";
import { MyTasksColumn } from "./column";
import {
  buildMyTasksColumns,
  findMyTask,
  type MyTask,
  projectSupportsStatus,
} from "./model";
import { MyTaskCardContent } from "./task-card";

type MyTasksBoardProps = {
  onBrowseProjects: () => void;
  onOpenTask: (task: MyTask) => void;
  projects: ProjectWithTasks[];
  taskCategory: TaskCategory;
  strategyHorizon?: TaskHorizon;
  hasTasksInOtherCategories?: boolean;
  hasTasksOutsideHorizon?: boolean;
};

export default function MyTasksBoard({
  onBrowseProjects,
  onOpenTask,
  projects,
  taskCategory,
  strategyHorizon,
  hasTasksInOtherCategories: completeOtherCategoryHint,
  hasTasksOutsideHorizon: completeHorizonHint,
}: MyTasksBoardProps) {
  const { t } = useTranslation();
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [statusOverrides, setStatusOverrides] = useState<
    Record<string, string>
  >({});
  const { mutateAsync: updateTaskStatus } = useUpdateTaskStatus();

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 10 },
    }),
    useSensor(KeyboardSensor),
  );

  useEffect(() => {
    setStatusOverrides((current) => {
      let changed = false;
      const next = { ...current };

      for (const [taskId, status] of Object.entries(current)) {
        const task = findMyTask(projects, taskId);

        if (task?.status === status) {
          delete next[taskId];
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [projects]);

  const columns = useMemo(
    () =>
      buildMyTasksColumns(
        projects,
        statusOverrides,
        taskCategory,
        t("tasks:myTasks.blockedColumn"),
        strategyHorizon,
      ),
    [projects, statusOverrides, strategyHorizon, taskCategory, t],
  );
  const hasTasksInOtherCategories = useMemo(
    () => buildMyTasksColumns(projects).some((column) => column.tasks.length),
    [projects],
  );
  const hasTasksOutsideHorizon = useMemo(
    () =>
      buildMyTasksColumns(projects, {}, taskCategory).some(
        (column) => column.tasks.length,
      ),
    [projects, taskCategory],
  );
  const tasks = useMemo(
    () => columns.flatMap((column) => column.tasks),
    [columns],
  );
  const activeTask = activeTaskId
    ? tasks.find((task) => task.id === activeTaskId)
    : undefined;

  const handleDragStart = (event: DragStartEvent) => {
    setActiveTaskId(event.active.id.toString());
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveTaskId(null);

    const task = tasks.find((item) => item.id === event.active.id.toString());
    const status = event.over?.data.current?.status;
    if (!task || typeof status !== "string" || status === task.status) return;

    if (!projectSupportsStatus(projects, task.projectId, status)) {
      toast.error(
        t("tasks:myTasks.statusUnavailable", { project: task.projectName }),
      );
      return;
    }

    setStatusOverrides((current) => ({ ...current, [task.id]: status }));

    try {
      await updateTaskStatus({ ...task, status });
    } catch (error) {
      setStatusOverrides((current) => {
        const next = { ...current };
        delete next[task.id];
        return next;
      });
      toast.error(
        error instanceof Error
          ? error.message
          : t("tasks:myTasks.statusUpdateError"),
      );
    }
  };

  if (tasks.length === 0) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ListChecks aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>
            {t(
              strategyHorizon && (completeHorizonHint ?? hasTasksOutsideHorizon)
                ? "tasks:myTasks.emptyHorizonTitle"
                : (completeOtherCategoryHint ?? hasTasksInOtherCategories)
                  ? "tasks:myTasks.emptyCategoryTitle"
                  : "tasks:myTasks.emptyTitle",
            )}
          </EmptyTitle>
          <EmptyDescription>
            {t(
              strategyHorizon && (completeHorizonHint ?? hasTasksOutsideHorizon)
                ? "tasks:myTasks.emptyHorizonDescription"
                : (completeOtherCategoryHint ?? hasTasksInOtherCategories)
                  ? "tasks:myTasks.emptyCategoryDescription"
                  : "tasks:myTasks.emptyDescription",
            )}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button type="button" variant="outline" onClick={onBrowseProjects}>
            {t("tasks:myTasks.browseProjects")}
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragCancel={() => setActiveTaskId(null)}
      onDragEnd={handleDragEnd}
    >
      <div className="h-full snap-x snap-mandatory overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch] md:snap-none">
        <div className="flex h-full min-w-max gap-3 px-3 py-3 sm:gap-4 sm:px-4 sm:py-4 md:px-5">
          {columns.map((column) => (
            <MyTasksColumn
              key={column.id}
              column={column}
              isDragging={Boolean(activeTask)}
              canDrop={
                !activeTask ||
                projectSupportsStatus(projects, activeTask.projectId, column.id)
              }
              onOpenTask={onOpenTask}
            />
          ))}
        </div>
      </div>
      <DragOverlay>
        {activeTask ? (
          <div className="w-80 rotate-1 scale-[1.02] shadow-lg">
            <MyTaskCardContent task={activeTask} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
