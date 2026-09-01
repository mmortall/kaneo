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
import { TASK_CATEGORIES } from "@/types/task";

type TaskCategorySelectProps = {
  className?: string;
  task: Task;
};

export default function TaskCategorySelect({
  className,
  task,
}: TaskCategorySelectProps) {
  const { t } = useTranslation();
  const { mutateAsync: updateTask, isPending } = useUpdateTask();
  const value = task.taskCategory ?? "live_implementation";
  const items = useMemo(
    () =>
      TASK_CATEGORIES.map((category) => ({
        label:
          category === "live_implementation"
            ? t("tasks:categories.liveImplementation")
            : category === "research"
              ? t("tasks:categories.research")
              : t("tasks:categories.agentBlocker"),
        value: category,
      })),
    [t],
  );
  const selectedItem = items.find((item) => item.value === value) ?? items[0];

  return (
    <Select
      items={items}
      value={value}
      disabled={isPending}
      onValueChange={async (nextValue) => {
        if (!nextValue || nextValue === value) return;
        try {
          await updateTask({
            ...task,
            taskCategory: nextValue,
          });
        } catch (error) {
          toast.error(
            error instanceof Error
              ? error.message
              : t("tasks:categories.updateError"),
          );
        }
      }}
    >
      <SelectTrigger
        size="sm"
        className={className}
        aria-label={t("tasks:categories.label")}
      >
        <SelectValue>{selectedItem.label}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
