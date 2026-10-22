import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import BoardToolbar from "@/components/board/board-toolbar";
import ProjectLayout from "@/components/common/project-layout";
import KanbanBoard from "@/components/kanban-board";
import ListView from "@/components/list-view";
import PageTitle from "@/components/page-title";
import CreateTaskModal from "@/components/shared/modals/create-task-modal";
import TaskDetailsSheet from "@/components/task/task-details-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { shortcuts } from "@/constants/shortcuts";
import { useGetTaskView } from "@/hooks/queries/task/use-get-task-view";
import { useGetActiveWorkspaceUsers } from "@/hooks/queries/workspace-users/use-get-active-workspace-users";
import { useBoardSort } from "@/hooks/use-board-sort";
import { useRegisterShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useTaskFiltersWithLabelsSupport } from "@/hooks/use-task-filters-with-labels-support";
import { taskViewFilters } from "@/lib/task-view-filters";
import useBulkSelectionStore from "@/store/bulk-selection";
import useProjectStore from "@/store/project";
import { useUserPreferencesStore } from "@/store/user-preferences";

type BoardSearchParams = {
  taskId?: string;
};

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/workspace/$workspaceId/project/$projectId/board",
)({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): BoardSearchParams => ({
    taskId: typeof search.taskId === "string" ? search.taskId : undefined,
  }),
});

const skeletonColumns = [
  { key: "col-todo", cards: 3 },
  { key: "col-progress", cards: 4 },
  { key: "col-review", cards: 2 },
  { key: "col-done", cards: 1 },
];

function BoardSkeleton() {
  return (
    <div className="flex h-full w-full gap-4 p-4 overflow-hidden">
      {skeletonColumns.map((col) => (
        <div key={col.key} className="flex w-72 shrink-0 flex-col gap-3">
          <div className="flex items-center gap-2 px-1">
            <div className="h-3 w-3 rounded-full bg-muted animate-pulse" />
            <div className="h-4 w-24 rounded bg-muted animate-pulse" />
            <div className="h-4 w-5 rounded bg-muted animate-pulse" />
          </div>
          <div className="flex flex-col gap-2.5">
            {Array.from({ length: col.cards }, (_, i) => `${col.key}-${i}`).map(
              (cardKey) => (
                <div
                  key={cardKey}
                  className="rounded-lg border border-border bg-card p-3 space-y-2.5"
                >
                  <div className="h-3.5 w-4/5 rounded bg-muted animate-pulse" />
                  <div className="h-3 w-3/5 rounded bg-muted animate-pulse" />
                  <div className="flex items-center gap-2 pt-1">
                    <div className="h-5 w-5 rounded-full bg-muted animate-pulse" />
                    <div className="h-3 w-16 rounded bg-muted animate-pulse" />
                  </div>
                </div>
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function RouteComponent() {
  const { t } = useTranslation();
  const { projectId, workspaceId } = Route.useParams();
  const { taskId } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setProject } = useProjectStore();
  const { viewMode, setViewMode, weekStartsOn } = useUserPreferencesStore();
  const [pageState, setPageState] = useState({ scope: "", page: 1 });
  const [searchText, setSearchText] = useState("");
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [boardSearchQuery, setBoardSearchQuery] = useState("");
  const [isBoardSearchMounted, setIsBoardSearchMounted] = useState(false);
  const [isBoardSearchVisible, setIsBoardSearchVisible] = useState(false);
  const [boardSearchInput, setBoardSearchInput] =
    useState<HTMLInputElement | null>(null);
  const { sort, setSort } = useBoardSort(projectId);

  const { data: users } = useGetActiveWorkspaceUsers(workspaceId);

  const handleCloseTaskSheet = useCallback(() => {
    navigate({
      to: ".",
      search: {},
      replace: true,
    });
  }, [navigate]);

  useRegisterShortcuts({
    sequentialShortcuts: {
      [shortcuts.view.prefix]: {
        [shortcuts.view.board]: () => setViewMode("board"),
        [shortcuts.view.list]: () => setViewMode("list"),
        [shortcuts.view.gantt]: () =>
          navigate({
            to: "/dashboard/workspace/$workspaceId/project/$projectId/gantt",
            params: { workspaceId, projectId },
          }),
        [shortcuts.view.backlog]: () =>
          navigate({
            to: "/dashboard/workspace/$workspaceId/project/$projectId/backlog",
            params: { workspaceId, projectId },
          }),
      },
    },
  });

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchText(boardSearchQuery), 250);
    return () => window.clearTimeout(timer);
  }, [boardSearchQuery]);

  const openBoardSearch = useCallback(() => {
    setIsBoardSearchMounted(true);
    window.requestAnimationFrame(() => setIsBoardSearchVisible(true));
  }, []);

  const closeBoardSearch = useCallback(() => {
    setIsBoardSearchVisible(false);
    window.setTimeout(() => setIsBoardSearchMounted(false), 180);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isFindShortcut =
        (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f";

      if (!isFindShortcut) return;

      event.preventDefault();
      openBoardSearch();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openBoardSearch]);

  useEffect(() => {
    if (!isBoardSearchMounted) return;
    window.requestAnimationFrame(() => boardSearchInput?.focus());
  }, [isBoardSearchMounted, boardSearchInput]);

  const { filters, updateFilter, hasActiveFilters, clearFilters } =
    useTaskFiltersWithLabelsSupport(undefined, projectId);

  const serverFilters = useMemo(
    () => ({
      ...taskViewFilters(filters, searchText, weekStartsOn, new Date()),
      excludeStatuses: ["archived", "planned", "blocked"],
    }),
    [filters, searchText, weekStartsOn],
  );
  const scope = JSON.stringify([projectId, serverFilters, sort]);
  const page = pageState.scope === scope ? pageState.page : 1;
  const view = useGetTaskView(projectId, {
    filters: serverFilters,
    page,
    limit: 50,
    sortBy: sort.field,
    sortOrder: sort.direction,
  });
  const project = view.data?.data;
  const pagination = view.data?.pagination;
  useEffect(() => {
    setProject(project);
  }, [project, setProject]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list kept as deployed; it intentionally re-runs or resets on these values
  useEffect(() => {
    const selection = useBulkSelectionStore.getState();
    selection.clearSelection();
    selection.clearFocus();
  }, [scope, page]);
  useEffect(() => {
    if (
      pagination &&
      pagination.totalPages !== null &&
      page > pagination.totalPages
    ) {
      void queryClient.invalidateQueries({
        queryKey: ["tasks", projectId, "view"],
        refetchType: "none",
      });
      setPageState({ scope, page: pagination.totalPages });
    }
  }, [pagination, page, scope, projectId, queryClient]);

  const boardHeaderSearch = isBoardSearchMounted ? (
    <div
      className={`relative w-[240px] origin-top transition-[translate,scale,opacity] duration-180 ease-out ${
        isBoardSearchVisible
          ? "translate-y-0 scale-y-100 opacity-100"
          : "pointer-events-none -translate-y-1 scale-y-95 opacity-0"
      }`}
    >
      <Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 text-muted-foreground" />
      <Input
        ref={setBoardSearchInput}
        value={boardSearchQuery}
        onChange={(event) => setBoardSearchQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !boardSearchQuery.trim()) {
            closeBoardSearch();
          }
        }}
        onBlur={() => {
          if (!boardSearchQuery.trim()) {
            closeBoardSearch();
          }
        }}
        placeholder={t("tasks:boardSearchPlaceholder")}
        className="h-7.5 [&_[data-slot=input]]:h-7 [&_[data-slot=input]]:leading-7 [&_[data-slot=input]]:pl-8 [&_[data-slot=input]]:text-xs [&_[data-slot=input]]:placeholder:text-xs [&_[data-slot=input]]:placeholder:leading-7"
      />
    </div>
  ) : null;

  return (
    <ProjectLayout
      projectId={projectId}
      workspaceId={workspaceId}
      activeView="board"
      headerActions={boardHeaderSearch}
    >
      <PageTitle
        title={`${project?.name} · ${viewMode === "board" ? t("tasks:view.board") : t("tasks:view.list")}`}
        hideAppName
      />
      <div className="relative flex flex-col h-full min-h-0 overflow-hidden">
        <BoardToolbar
          project={project}
          filters={filters}
          updateFilter={updateFilter}
          clearFilters={clearFilters}
          hasActiveFilters={hasActiveFilters}
          users={users}
          workspaceId={workspaceId}
          viewMode={viewMode}
          setViewMode={setViewMode}
          sort={sort}
          onSortChange={setSort}
        />

        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-sm">
          <span>
            {pagination
              ? `Page ${page} of ${pagination.totalPages} - ${pagination.total} tasks`
              : "Loading..."}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || view.isFetching}
            onClick={() => setPageState({ scope, page: page - 1 })}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!pagination?.hasMore || view.isFetching}
            onClick={() => setPageState({ scope, page: page + 1 })}
          >
            Next
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={view.isFetching}
            onClick={() => void view.refetch()}
          >
            Refresh
          </Button>
          <span className="text-muted-foreground">
            Selections apply to this page.
          </span>
        </div>
        {view.isError && (
          <p role="alert" className="px-4 py-2 text-destructive">
            {view.error.message}
          </p>
        )}
        <div className="flex h-full flex-1 overflow-hidden bg-background">
          {project ? (
            viewMode === "board" ? (
              <KanbanBoard
                project={project}
                disableDragDrop={sort.field !== "position"}
              />
            ) : (
              <ListView
                project={project}
                disableDragDrop={sort.field !== "position"}
              />
            )
          ) : (
            <BoardSkeleton />
          )}
        </div>

        <CreateTaskModal
          open={isTaskModalOpen}
          projectId={projectId}
          onClose={() => setIsTaskModalOpen(false)}
        />

        <TaskDetailsSheet
          taskId={taskId}
          projectId={projectId}
          workspaceId={workspaceId}
          onClose={handleCloseTaskSheet}
        />
      </div>
    </ProjectLayout>
  );
}
