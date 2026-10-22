import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ListChecks, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import WorkspaceLayout from "@/components/common/workspace-layout";
import MyTasksBoard from "@/components/my-tasks-board";
import type { MyTask } from "@/components/my-tasks-board/model";
import PageTitle from "@/components/page-title";
import TaskDetailsSheet from "@/components/task/task-details-sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useGetMyTasks } from "@/hooks/queries/task/use-get-my-tasks";
import { authClient } from "@/lib/auth-client";
import {
  TASK_HORIZONS,
  type TaskCategory,
  type TaskHorizon,
} from "@/types/task";

type MyTasksSearch = {
  category?: TaskCategory;
  horizon?: TaskHorizon;
  projectId?: string;
  taskId?: string;
};

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/workspace/$workspaceId/my-tasks",
)({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>): MyTasksSearch => ({
    category: isTaskCategory(search.category)
      ? search.category
      : "live_implementation",
    horizon: isTaskHorizon(search.horizon) ? search.horizon : undefined,
    projectId:
      typeof search.projectId === "string" ? search.projectId : undefined,
    taskId: typeof search.taskId === "string" ? search.taskId : undefined,
  }),
});

function RouteComponent() {
  const { t } = useTranslation();
  const { workspaceId } = Route.useParams();
  const {
    category = "live_implementation",
    horizon,
    projectId,
    taskId,
  } = Route.useSearch();
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();
  const [page, setPage] = useState(1);
  const filterKey = JSON.stringify([
    workspaceId,
    session?.user.id,
    category,
    horizon,
  ]);
  const [pageFilterKey, setPageFilterKey] = useState(filterKey);
  const requestedPage = pageFilterKey === filterKey ? page : 1;
  useEffect(() => {
    setPage(1);
    setPageFilterKey(filterKey);
  }, [filterKey]);
  const {
    data: projects,
    isError,
    isLoading,
    refetch,
    counts,
    pagination,
    isFetching,
  } = useGetMyTasks(workspaceId, session?.user.id, {
    page: requestedPage,
    category,
    horizon,
  });

  const openTask = (task: MyTask) => {
    navigate({
      to: ".",
      search: {
        category,
        horizon,
        projectId: task.projectId,
        taskId: task.id,
      },
    });
  };

  const closeTask = () => {
    navigate({ to: ".", search: { category, horizon }, replace: true });
  };

  const browseProjects = () => {
    navigate({
      to: "/dashboard/workspace/$workspaceId",
      params: { workspaceId },
    });
  };

  const taskCount = counts?.allCategoriesTotal ?? 0;
  const toDoCounts = counts?.todoByCategory ?? {
    live_implementation: 0,
    research: 0,
    agent_blocker: 0,
  };

  return (
    <WorkspaceLayout title={t("tasks:myTasks.title")}>
      <PageTitle title={t("tasks:myTasks.title")} />
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="shrink-0 border-b border-border/80 bg-card/80 px-3 py-3 sm:px-4 sm:py-2">
          <div className="flex min-h-10 flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold">
                {t("tasks:myTasks.title")}
              </h1>
              <p className="truncate text-xs text-muted-foreground">
                {t("tasks:myTasks.summary", {
                  count: taskCount,
                  projectCount: counts?.projectCount ?? 0,
                })}
              </p>
            </div>
            <div className="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <Tabs
                className="w-max"
                value={category}
                onValueChange={(value) =>
                  navigate({
                    to: ".",
                    search: { category: value as TaskCategory, horizon },
                    replace: true,
                  })
                }
              >
                <TabsList
                  className="w-max"
                  aria-label={t("tasks:categories.label")}
                >
                  {TASK_CATEGORY_TABS.map((tab) => (
                    <TabsTab
                      key={tab.value}
                      value={tab.value}
                      className="shrink-0"
                    >
                      {t(tab.labelKey)}
                      <Badge variant="outline" size="sm">
                        {t("tasks:myTasks.toDoCount", {
                          count: toDoCounts[tab.value],
                        })}
                      </Badge>
                    </TabsTab>
                  ))}
                </TabsList>
              </Tabs>
            </div>
          </div>
          <div className="pt-2">
            <span className="text-xs font-medium text-muted-foreground">
              {t("tasks:horizons.filterLabel")}
            </span>
            <div className="-mx-1 mt-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <ToggleGroup
                className="w-max"
                value={horizon ? [horizon] : []}
                onValueChange={(value) =>
                  navigate({
                    to: ".",
                    search: {
                      category,
                      horizon: value[0] as TaskHorizon | undefined,
                    },
                    replace: true,
                  })
                }
                variant="outline"
                size="sm"
                aria-label={t("tasks:horizons.filterLabel")}
              >
                {TASK_HORIZONS.map((value) => (
                  <ToggleGroupItem
                    key={value}
                    value={value}
                    className="shrink-0"
                    title={t(`tasks:horizons.${value}.description`)}
                  >
                    {t(`tasks:horizons.${value}.label`)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 bg-background">
          {isLoading ? (
            <MyTasksBoardSkeleton />
          ) : isError ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ListChecks aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>{t("tasks:myTasks.errorTitle")}</EmptyTitle>
                <EmptyDescription>
                  {t("tasks:myTasks.errorDescription")}
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => refetch()}
                >
                  <RefreshCw aria-hidden="true" />
                  {t("common:actions.retry")}
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <MyTasksBoard
              projects={projects}
              taskCategory={category}
              strategyHorizon={horizon}
              onOpenTask={openTask}
              onBrowseProjects={browseProjects}
              hasTasksInOtherCategories={(counts?.allCategoriesTotal ?? 0) > 0}
              hasTasksOutsideHorizon={
                (counts?.categoryAllHorizonsTotal ?? 0) > 0
              }
            />
          )}
        </div>
        <nav
          aria-label={t("common:pagination.label")}
          className="flex shrink-0 items-center justify-between border-t p-2"
        >
          <Button
            size="xs"
            variant="ghost"
            aria-label={t("common:pagination.previousPage")}
            disabled={isFetching || requestedPage === 1}
            onClick={() => setPage((value) => value - 1)}
          >
            {t("common:pagination.previous")}
          </Button>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {requestedPage} / {pagination?.totalPages ?? 1}
          </span>
          <Button
            size="xs"
            variant="ghost"
            aria-label={t("common:pagination.nextPage")}
            disabled={isFetching || !pagination?.hasMore}
            onClick={() => setPage((value) => value + 1)}
          >
            {t("common:pagination.next")}
          </Button>
        </nav>
      </div>

      {projectId && (
        <TaskDetailsSheet
          taskId={taskId}
          projectId={projectId}
          workspaceId={workspaceId}
          onClose={closeTask}
        />
      )}
    </WorkspaceLayout>
  );
}

const TASK_CATEGORY_TABS: Array<{
  labelKey:
    | "tasks:categories.liveImplementation"
    | "tasks:categories.research"
    | "tasks:categories.agentBlocker";
  value: TaskCategory;
}> = [
  {
    value: "live_implementation",
    labelKey: "tasks:categories.liveImplementation",
  },
  { value: "research", labelKey: "tasks:categories.research" },
  { value: "agent_blocker", labelKey: "tasks:categories.agentBlocker" },
];

function isTaskCategory(value: unknown): value is TaskCategory {
  return (
    value === "live_implementation" ||
    value === "research" ||
    value === "agent_blocker"
  );
}

function isTaskHorizon(value: unknown): value is TaskHorizon {
  return TASK_HORIZONS.includes(value as TaskHorizon);
}

function MyTasksBoardSkeleton() {
  return (
    <div className="flex h-full gap-4 overflow-hidden p-4">
      {["todo", "progress", "review", "done"].map((column) => (
        <div
          key={column}
          className="flex w-80 shrink-0 flex-col gap-3 rounded-xl border border-border/70 p-3"
        >
          <Skeleton className="h-5 w-28" />
          {[0, 1, 2].map((card) => (
            <Skeleton key={card} className="h-28 w-full rounded-xl" />
          ))}
        </div>
      ))}
    </div>
  );
}
