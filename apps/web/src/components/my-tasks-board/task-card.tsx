import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { CalendarDays } from "lucide-react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { formatDateShort } from "@/lib/format";
import { getInitials } from "@/lib/get-initials";
import { getPriorityLabel } from "@/lib/i18n/domain";
import { getPriorityIcon } from "@/lib/priority";
import type { TaskHorizon } from "@/types/task";
import type { MyTask } from "./model";

type MyTaskCardProps = {
  disabled?: boolean;
  onOpen: (task: MyTask) => void;
  task: MyTask;
};

export function MyTaskCard({ disabled, onOpen, task }: MyTaskCardProps) {
  const { attributes, isDragging, listeners, setNodeRef, transform } =
    useDraggable({
      id: task.id,
      data: { task },
      disabled,
    });

  const style: CSSProperties = {
    opacity: isDragging ? 0.35 : 1,
    transform: CSS.Translate.toString(transform),
  };

  return (
    <button
      ref={setNodeRef}
      type="button"
      style={style}
      className="w-full rounded-xl text-left outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => onOpen(task)}
      aria-label={`${task.projectSlug}-${task.number ?? ""}: ${task.title}`}
      {...attributes}
      {...listeners}
    >
      <MyTaskCardContent task={task} />
    </button>
  );
}

export function MyTaskCardContent({ task }: { task: MyTask }) {
  const { t } = useTranslation();
  const identifier = task.number
    ? `${task.projectSlug}-${task.number}`
    : task.projectSlug;

  return (
    <Card className="rounded-xl bg-background transition-[border-color,box-shadow] hover:border-border/90 hover:shadow-sm">
      <CardHeader className="flex flex-col gap-2 p-3 pb-2">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <Badge variant="outline" className="max-w-44 truncate">
            {task.projectName}
          </Badge>
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {identifier}
          </span>
        </div>
        <CardTitle className="text-sm leading-snug">{task.title}</CardTitle>
      </CardHeader>
      <CardPanel className="flex flex-wrap items-center gap-2 p-3 pt-0">
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <span aria-hidden="true">
            {getPriorityIcon(task.priority ?? "no-priority")}
          </span>
          {getPriorityLabel(task.priority ?? "no-priority")}
        </span>

        {task.dueDate && (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <CalendarDays aria-hidden="true" className="size-3" />
            {formatDateShort(task.dueDate)}
          </span>
        )}

        {(task.strategyHorizons ?? []).map((horizon) => (
          <Badge key={horizon} variant="secondary" size="sm">
            {t(`tasks:horizons.${horizon as TaskHorizon}.label`)}
          </Badge>
        ))}

        <span className="ml-auto">
          <Avatar className="size-5">
            <AvatarImage
              src={task.assigneeImage ?? ""}
              alt={task.assigneeName ?? t("common:people.unknown")}
            />
            <AvatarFallback className="text-[9px]">
              {getInitials(task.assigneeName)}
            </AvatarFallback>
          </Avatar>
        </span>
      </CardPanel>
    </Card>
  );
}
