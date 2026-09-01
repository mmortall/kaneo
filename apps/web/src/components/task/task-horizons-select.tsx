import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUpdateTask } from "@/hooks/mutations/task/use-update-task";
import { toast } from "@/lib/toast";
import type Task from "@/types/task";
import { TASK_HORIZONS, type TaskHorizon } from "@/types/task";

type TaskHorizonsSelectProps = {
  className?: string;
  disabled?: boolean;
  onValueChange: (value: TaskHorizon[]) => void | Promise<void>;
  value: TaskHorizon[];
};

export function TaskHorizonsSelect({
  className,
  disabled,
  onValueChange,
  value,
}: TaskHorizonsSelectProps) {
  const { t } = useTranslation();
  const items = useMemo(
    () =>
      TASK_HORIZONS.map((horizon) => ({
        description: t(`tasks:horizons.${horizon}.description`),
        label: t(`tasks:horizons.${horizon}.label`),
        value: horizon,
      })),
    [t],
  );
  const summary =
    value.length === 0
      ? t("tasks:horizons.none")
      : items
          .filter((item) => value.includes(item.value))
          .map((item) => item.label)
          .join(", ");

  return (
    <Select
      multiple
      items={items}
      value={value}
      disabled={disabled}
      onValueChange={(nextValue) => onValueChange([...nextValue])}
    >
      <SelectTrigger
        size="sm"
        className={className}
        aria-label={t("tasks:horizons.label")}
      >
        <SelectValue>{summary}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            <span className="flex min-w-0 flex-col">
              <span>{item.label}</span>
              <span className="text-xs text-muted-foreground">
                {item.description}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export default function TaskHorizonsTaskSelect({
  className,
  task,
}: {
  className?: string;
  task: Task;
}) {
  const { t } = useTranslation();
  const { mutateAsync: updateTask, isPending } = useUpdateTask();

  return (
    <TaskHorizonsSelect
      className={className}
      disabled={isPending}
      value={task.strategyHorizons ?? []}
      onValueChange={async (strategyHorizons) => {
        try {
          await updateTask({ ...task, strategyHorizons });
        } catch (error) {
          toast.error(
            error instanceof Error
              ? error.message
              : t("tasks:horizons.updateError"),
          );
        }
      }}
    />
  );
}
