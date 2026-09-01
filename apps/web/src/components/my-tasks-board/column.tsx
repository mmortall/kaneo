import { useDroppable } from "@dnd-kit/core";
import { LockKeyhole } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { getColumnIcon } from "@/lib/column";
import type { MyTask, MyTasksColumn as MyTasksColumnModel } from "./model";
import { MyTaskCard } from "./task-card";

type MyTasksColumnProps = {
  canDrop: boolean;
  isDragging: boolean;
  onOpenTask: (task: MyTask) => void;
  column: MyTasksColumnModel;
};

export function MyTasksColumn({
  canDrop,
  column,
  isDragging,
  onOpenTask,
}: MyTasksColumnProps) {
  const { t } = useTranslation();
  const { isOver, setNodeRef } = useDroppable({
    id: `my-tasks-column:${column.id}`,
    data: { status: column.id },
    disabled: isDragging && !canDrop,
  });

  return (
    <section
      ref={setNodeRef}
      className={cn(
        "flex h-full min-h-0 w-80 shrink-0 flex-col rounded-xl border border-border/70 bg-muted/40 transition-[border-color,opacity,box-shadow] dark:bg-card/90",
        isOver && "border-ring/40 shadow-md ring-2 ring-ring/30",
        isDragging && !canDrop && "opacity-45",
      )}
      aria-label={column.name}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <span className="text-muted-foreground" aria-hidden="true">
          {getColumnIcon(column.id, column.isFinal, column.icon)}
        </span>
        <h2 className="truncate text-sm font-medium">{column.name}</h2>
        <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
          {column.tasks.length}
        </span>
        {isDragging && !canDrop && (
          <span
            className="ml-auto inline-flex items-center gap-1 text-[10px] text-muted-foreground"
            title={t("tasks:myTasks.statusUnavailableShort")}
          >
            <LockKeyhole aria-hidden="true" className="size-3" />
            {t("tasks:myTasks.statusUnavailableShort")}
          </span>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <div className="flex min-h-full flex-col gap-2">
          {column.tasks.map((task) => (
            <MyTaskCard key={task.id} task={task} onOpen={onOpenTask} />
          ))}
          {column.tasks.length === 0 && (
            <div className="flex min-h-20 flex-1 items-center justify-center rounded-lg border border-dashed border-border/70 px-4 text-center text-xs text-muted-foreground">
              {t("tasks:myTasks.emptyColumn")}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
