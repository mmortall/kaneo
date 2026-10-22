import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Calendar, Filter, Plus, User, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import BacklogListView from "@/components/backlog-list-view";
import LabelFilterPicker from "@/components/common/label-filter-picker";
import ProjectLayout from "@/components/common/project-layout";
import SortControl from "@/components/common/sort-control";
import PageTitle from "@/components/page-title";
import CreateTaskModal from "@/components/shared/modals/create-task-modal";
import { TaskGroupModal } from "@/components/shared/modals/task-group-modal";
import TaskDetailsSheet from "@/components/task/task-details-sheet";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { shortcuts } from "@/constants/shortcuts";
import { useGetTaskView } from "@/hooks/queries/task/use-get-task-view";
import { useGetActiveWorkspaceUsers } from "@/hooks/queries/workspace-users/use-get-active-workspace-users";
import { useRegisterShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { DUE_DATE_FILTER_VALUES } from "@/hooks/use-task-filters";
import { getInitials } from "@/lib/get-initials";
import { getPriorityLabel } from "@/lib/i18n/domain";
import { getPriorityIcon } from "@/lib/priority";
import type { SortConfig } from "@/lib/sort-tasks";
import { taskViewFilters } from "@/lib/task-view-filters";
import useBacklogBulkSelectionStore from "@/store/backlog-bulk-selection";
import useProjectStore from "@/store/project";
import { useUserPreferencesStore } from "@/store/user-preferences";

type BacklogSearchParams = {
  taskId?: string;
};

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/workspace/$workspaceId/project/$projectId/backlog",
)({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): BacklogSearchParams => ({
    taskId: typeof search.taskId === "string" ? search.taskId : undefined,
  }),
});

function RouteComponent() {
  const { t } = useTranslation();
  const { projectId, workspaceId } = Route.useParams();
  const { taskId } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setProject } = useProjectStore();
  const [section, setSection] = useState<"planned" | "blocked" | "archived">(
    "planned",
  );
  const [pageState, setPageState] = useState({ scope: "", page: 1 });
  const weekStartsOn = useUserPreferencesStore((state) => state.weekStartsOn);
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [isActivationModalOpen, setIsActivationModalOpen] = useState(false);
  const [sort, setSort] = useState<SortConfig>({
    field: "position",
    direction: "asc",
  });

  const { data: users } = useGetActiveWorkspaceUsers(workspaceId);

  const handleCloseTaskSheet = useCallback(() => {
    navigate({
      to: ".",
      search: {},
      replace: true,
    });
  }, [navigate]);

  const { setViewMode } = useUserPreferencesStore();

  useRegisterShortcuts({
    sequentialShortcuts: {
      [shortcuts.view.prefix]: {
        [shortcuts.view.board]: () => {
          setViewMode("board");
          navigate({
            to: "/dashboard/workspace/$workspaceId/project/$projectId/board",
            params: { workspaceId, projectId },
          });
        },
        [shortcuts.view.list]: () => {
          setViewMode("list");
          navigate({
            to: "/dashboard/workspace/$workspaceId/project/$projectId/board",
            params: { workspaceId, projectId },
          });
        },
        [shortcuts.view.gantt]: () => {
          navigate({
            to: "/dashboard/workspace/$workspaceId/project/$projectId/gantt",
            params: { workspaceId, projectId },
          });
        },
        [shortcuts.view.backlog]: () => {},
      },
    },
  });

  const [filters, setFilters] = useState({
    priority: null as string | null,
    assignee: null as string | null,
    dueDate: null as string | null,
    labels: [] as string[],
  });

  const updateFilter = (key: string, value: string | null) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const clearFilters = () => {
    setFilters({
      priority: null,
      assignee: null,
      dueDate: null,
      labels: [],
    });
  };

  const hasActiveFilters = Object.values(filters).some((filter) =>
    Array.isArray(filter) ? filter.length > 0 : filter !== null,
  );

  const serverFilters = useMemo(
    () =>
      taskViewFilters(
        {
          status: [section],
          priority: filters.priority ? [filters.priority] : null,
          assignee: filters.assignee ? [filters.assignee] : null,
          dueDate: filters.dueDate ? [filters.dueDate] : null,
          labels: filters.labels.length ? filters.labels : null,
        },
        "",
        weekStartsOn,
        new Date(),
      ),
    [section, filters, weekStartsOn],
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
  useEffect(() => {
    setProject(project);
  }, [project, setProject]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency list kept as deployed; it intentionally re-runs or resets on these values
  useEffect(() => {
    const selection = useBacklogBulkSelectionStore.getState();
    selection.clearSelection();
    selection.clearFocus();
  }, [scope, page]);

  const getAssigneeDisplayName = (userId: string) => {
    const member = users?.members?.find((m) => m.userId === userId);
    return member?.user?.name || t("common:people.unknown");
  };

  return (
    <ProjectLayout
      projectId={projectId}
      workspaceId={workspaceId}
      activeView="backlog"
    >
      <TaskGroupModal
        open={isActivationModalOpen}
        onClose={() => setIsActivationModalOpen(false)}
        projectId={projectId}
        action="activate_planned"
        status="to-do"
        destinationName={
          project?.columns.find((column) => column.id === "to-do")?.name ??
          "To Do"
        }
      />
      <PageTitle
        title={t("tasks:backlog.pageTitle", { name: project?.name })}
      />
      <div className="relative flex flex-col h-full min-h-0 overflow-hidden">
        <div className="border-border/80 border-b bg-card/80 backdrop-blur supports-[backdrop-filter]:bg-card/70">
          <div className="flex min-h-12 items-center px-3 py-2 md:px-4">
            <div className="flex w-full items-center gap-2">
              <div className="flex w-full flex-wrap items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setIsTaskModalOpen(true)}
                  className="h-6 px-2 text-xs text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                >
                  <Plus className="h-3 w-3 mr-1" />
                  {t("tasks:backlog.plan")}
                </Button>

                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setIsActivationModalOpen(true)}
                  className="h-6 px-2 text-xs text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  title={t("tasks:backlog.moveAllTooltip")}
                >
                  <ArrowRight className="h-3 w-3 mr-1" />
                  {t("tasks:backlog.moveAll")}
                </Button>

                {filters.priority && (
                  <Button
                    variant="secondary"
                    size="xs"
                    className="h-7 rounded-md px-2 text-xs font-medium gap-1.5"
                  >
                    {getPriorityIcon(filters.priority)}
                    <span>
                      {t("tasks:backlog.filters.priority", {
                        name: getPriorityLabel(filters.priority),
                      })}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-4 w-4 p-0 ml-1 hover:bg-destructive hover:text-destructive-foreground"
                      onClick={(e) => {
                        e.stopPropagation();
                        updateFilter("priority", null);
                      }}
                    >
                      <X className="h-2.5 w-2.5" />
                    </Button>
                  </Button>
                )}

                {filters.assignee && (
                  <Button
                    variant="secondary"
                    size="xs"
                    className="h-7 rounded-md px-2 text-xs font-medium gap-1.5"
                  >
                    <User className="h-3 w-3" />
                    <span>
                      {t("tasks:backlog.filters.assignee", {
                        name: getAssigneeDisplayName(filters.assignee),
                      })}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-4 w-4 p-0 ml-1 hover:bg-destructive hover:text-destructive-foreground"
                      onClick={(e) => {
                        e.stopPropagation();
                        updateFilter("assignee", null);
                      }}
                    >
                      <X className="h-2.5 w-2.5" />
                    </Button>
                  </Button>
                )}

                {filters.dueDate && (
                  <Button
                    variant="secondary"
                    size="xs"
                    className="h-7 rounded-md px-2 text-xs font-medium gap-1.5"
                  >
                    <Calendar className="h-3 w-3" />
                    <span>
                      {t("tasks:backlog.filters.due", {
                        date: t(
                          filters.dueDate === DUE_DATE_FILTER_VALUES.dueThisWeek
                            ? "tasks:backlog.filters.dueThisWeek"
                            : filters.dueDate ===
                                DUE_DATE_FILTER_VALUES.dueNextWeek
                              ? "tasks:backlog.filters.dueNextWeek"
                              : "tasks:backlog.filters.noDueDate",
                          { defaultValue: filters.dueDate },
                        ),
                      })}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-4 w-4 p-0 ml-1 hover:bg-destructive hover:text-destructive-foreground"
                      onClick={(e) => {
                        e.stopPropagation();
                        updateFilter("dueDate", null);
                      }}
                    >
                      <X className="h-2.5 w-2.5" />
                    </Button>
                  </Button>
                )}

                <LabelFilterPicker
                  workspaceId={workspaceId}
                  selected={filters.labels}
                  onChange={(values) =>
                    setFilters((prev) => ({ ...prev, labels: values ?? [] }))
                  }
                />

                <SortControl sort={sort} onSortChange={setSort} />

                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 gap-2 px-2.5 text-xs font-medium text-foreground"
                      />
                    }
                  >
                    <Filter className="h-3.5 w-3.5" />
                    {t("tasks:backlog.filter")}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-80" align="start">
                    <DropdownMenuItem
                      disabled
                      className="h-8 rounded-md border border-border/80 bg-card text-sm text-muted-foreground"
                    >
                      {t("tasks:backlog.addFilter")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {hasActiveFilters && (
                      <>
                        <DropdownMenuItem
                          onClick={clearFilters}
                          className="h-8 text-sm text-muted-foreground"
                        >
                          <span>{t("common:actions.clearAllFilters")}</span>
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                      </>
                    )}
                    <DropdownMenuGroup>
                      <DropdownMenuLabel className="text-[11px] uppercase tracking-wide">
                        {t("tasks:priority.label")}
                      </DropdownMenuLabel>
                    </DropdownMenuGroup>
                    {["urgent", "high", "medium", "low"].map((priority) => (
                      <DropdownMenuCheckboxItem
                        key={priority}
                        checked={filters.priority === priority}
                        onCheckedChange={(checked) =>
                          updateFilter("priority", checked ? priority : null)
                        }
                        className="h-8 rounded-md text-sm [&_svg]:text-sidebar-foreground"
                      >
                        <div className="flex gap-2 items-center">
                          {getPriorityIcon(priority)}
                          <span className="capitalize">
                            {getPriorityLabel(priority)}
                          </span>
                        </div>
                      </DropdownMenuCheckboxItem>
                    ))}

                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuLabel className="text-[11px] uppercase tracking-wide">
                        {t("tasks:assignee.label")}
                      </DropdownMenuLabel>
                    </DropdownMenuGroup>
                    {users?.members?.map((member) => (
                      <DropdownMenuCheckboxItem
                        key={member.userId}
                        checked={filters.assignee === member.userId}
                        onCheckedChange={(checked) =>
                          updateFilter(
                            "assignee",
                            checked ? member.userId : null,
                          )
                        }
                        className="h-8 rounded-md text-sm"
                      >
                        <Avatar className="h-6 w-6 mr-2">
                          <AvatarImage
                            src={member.user?.image ?? ""}
                            alt={member.user?.name || ""}
                          />
                          <AvatarFallback className="text-xs font-medium border border-border/30">
                            {getInitials(member.user?.name)}
                          </AvatarFallback>
                        </Avatar>
                        <span>{member.user?.name}</span>
                      </DropdownMenuCheckboxItem>
                    ))}

                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuLabel className="text-[11px] uppercase tracking-wide">
                        {t("tasks:dueDate.label")}
                      </DropdownMenuLabel>
                    </DropdownMenuGroup>
                    {[
                      {
                        label: DUE_DATE_FILTER_VALUES.dueThisWeek,
                        key: "dueThisWeek",
                      },
                      {
                        label: DUE_DATE_FILTER_VALUES.dueNextWeek,
                        key: "dueNextWeek",
                      },
                      {
                        label: DUE_DATE_FILTER_VALUES.noDueDate,
                        key: "noDueDate",
                      },
                    ].map((item) => (
                      <DropdownMenuCheckboxItem
                        key={item.label}
                        checked={filters.dueDate === item.label}
                        onCheckedChange={(checked) =>
                          updateFilter("dueDate", checked ? item.label : null)
                        }
                        className="h-8 rounded-md text-sm"
                      >
                        <span>{t(`tasks:backlog.filters.${item.key}`)}</span>
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
          {/* biome-ignore lint/a11y/useSemanticElements: styled segmented control, not a form fieldset */}
          <div className="flex gap-1" role="group" aria-label="Backlog section">
            {(["planned", "blocked", "archived"] as const).map((value) => (
              <Button
                key={value}
                variant={section === value ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={section === value}
                onClick={() => setSection(value)}
              >
                {t(`tasks:backlog.sections.${value}`, {
                  defaultValue:
                    value === "archived"
                      ? "Archive"
                      : value === "blocked"
                        ? "Blocked"
                        : "Planned",
                })}
              </Button>
            ))}
          </div>
          {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: label names the pager region as deployed */}
          <div className="flex items-center gap-2" aria-label="Task pages">
            <span className="text-sm text-muted-foreground">
              {pagination
                ? `Page ${pagination.page} of ${pagination.totalPages} · ${pagination.total} tasks`
                : view.isPending
                  ? "Loading…"
                  : "Page unavailable"}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={view.isFetching || !pagination || page <= 1}
              onClick={() => setPageState({ scope, page: page - 1 })}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={view.isFetching || !pagination?.hasMore}
              onClick={() => setPageState({ scope, page: page + 1 })}
            >
              Next
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={view.isFetching}
              onClick={() => {
                void view.refetch();
              }}
            >
              Refresh
            </Button>
          </div>
        </div>
        <p className="px-4 py-1 text-xs text-muted-foreground">
          Selections apply to this page.
        </p>
        <div className="flex-1 overflow-hidden bg-card h-full">
          {view.error ? (
            <p role="alert" className="p-4 text-destructive">
              {view.error.message}
            </p>
          ) : project ? (
            <BacklogListView
              project={project}
              sections={[section]}
              disableDragDrop={sort.field !== "position"}
            />
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="text-center space-y-4">
                <div className="w-16 h-16 bg-muted rounded-lg animate-pulse mx-auto" />
                <div className="space-y-2">
                  <div className="w-48 h-4 bg-muted rounded animate-pulse mx-auto" />
                  <div className="w-64 h-3 bg-muted rounded animate-pulse mx-auto" />
                </div>
              </div>
            </div>
          )}
        </div>

        <CreateTaskModal
          open={isTaskModalOpen}
          projectId={projectId}
          onClose={() => setIsTaskModalOpen(false)}
          status="planned"
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
