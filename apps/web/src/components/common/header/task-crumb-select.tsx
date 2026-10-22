import { ChevronsUpDown } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useGetTaskView } from "@/hooks/queries/task/use-get-task-view";

type TaskCrumbSelectProps = {
  projectId: string;
  taskId: string;
  taskLabel?: string;
  onSelectTask: (taskId: string) => void;
};

export default function TaskCrumbSelect({
  projectId,
  taskId,
  taskLabel,
  onSelectTask,
}: TaskCrumbSelectProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => {
    if (query === search) return;
    const timer = setTimeout(() => {
      setSearch(query);
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [query, search]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list kept as deployed; it intentionally re-runs or resets on these values
  useEffect(() => {
    setQuery("");
    setSearch("");
    setPage(1);
  }, [projectId]);
  const result = useGetTaskView(open ? projectId : "", {
    page,
    filters: { text: search },
  });
  const project = result.data?.data;
  const tasks = [
    ...(project?.columns.flatMap((column) => column.tasks) ?? []),
    ...(project?.plannedTasks ?? []),
    ...(project?.blockedTasks ?? []),
    ...(project?.archivedTasks ?? []),
  ];
  const busy = result.isFetching || query !== search;
  const pagination = result.data?.pagination;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="h-7 max-w-56 justify-between gap-1.5 px-2 text-xs text-foreground"
          />
        }
      >
        <span className="truncate text-left">
          {taskLabel || t("tasks:common.selectTask")}
        </span>
        <ChevronsUpDown className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command
          items={tasks}
          mode="none"
          value={query}
          onValueChange={setQuery}
          itemToStringValue={(task) => (task as (typeof tasks)[number]).title}
        >
          <CommandInput
            maxLength={512}
            aria-label={t("tasks:boardSearchPlaceholder")}
            placeholder={t("tasks:boardSearchPlaceholder")}
          />
          <CommandEmpty>
            {busy ? t("common:empty.loading") : t("tasks:listView.noTasks")}
          </CommandEmpty>
          <CommandList className="max-h-64 overflow-y-auto">
            {(task: (typeof tasks)[number]) => (
              <CommandItem
                key={task.id}
                value={task}
                disabled={busy || task.id === taskId}
                onClick={() => {
                  onSelectTask(task.id);
                  setOpen(false);
                }}
                className="h-8 gap-2 text-sm"
              >
                <span className="min-w-0 truncate">
                  {task.number != null ? "#" + task.number + " " : ""}
                  {task.title}
                </span>
              </CommandItem>
            )}
          </CommandList>
        </Command>
        {result.error && (
          <div className="p-2 text-sm text-destructive" role="alert">
            {result.error.message}
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void result.refetch()}
            >
              {t("common:actions.retry")}
            </Button>
          </div>
        )}
        <nav
          aria-label={t("common:pagination.label")}
          className="flex items-center justify-between border-t p-2"
        >
          <Button
            size="xs"
            variant="ghost"
            aria-label={t("common:pagination.previousPage")}
            disabled={busy || page === 1}
            onClick={() => setPage((value) => value - 1)}
          >
            {t("common:pagination.previous")}
          </Button>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {page} / {pagination?.totalPages ?? 1}
          </span>
          <Button
            size="xs"
            variant="ghost"
            aria-label={t("common:pagination.nextPage")}
            disabled={busy || !pagination?.hasMore}
            onClick={() => setPage((value) => value + 1)}
          >
            {t("common:pagination.next")}
          </Button>
        </nav>
      </PopoverContent>
    </Popover>
  );
}
