import { useMutation, useQueryClient } from "@tanstack/react-query";
import bulkOperation from "@/fetchers/task/bulk-operation";
import { deleteOperation } from "@/fetchers/task/delete-operation";
import useProjectStore from "@/store/project";

export function useBulkOperations() {
  const queryClientRef = useQueryClient();
  const project = useProjectStore((state) => state.project);
  const fieldOperation = (input: Parameters<typeof bulkOperation>[0]) => {
    const loaded = new Map(
      [
        ...(project?.columns.flatMap((column) => column.tasks) ?? []),
        ...(project?.plannedTasks ?? []),
        ...(project?.archivedTasks ?? []),
        ...(project?.blockedTasks ?? []),
      ].map((task) => [task.id, task]),
    );
    const expectedVersions = input.taskIds.map((id) => {
      const version = loaded.get(id)?.version;
      if (!Number.isInteger(version) || (version ?? 0) < 1)
        throw new Error(
          "Reload selected tasks before applying bulk changes; task version is missing.",
        );
      return { id, version: version! };
    });
    if (input.operation === "delete") {
      if (!project?.id)
        throw new Error("Reload project before deleting selected tasks.");
      return deleteOperation(project.id, expectedVersions);
    }
    return bulkOperation({ ...input, expectedVersions });
  };

  const invalidateCommon = () => {
    queryClientRef.invalidateQueries({ queryKey: ["tasks"] });
    queryClientRef.invalidateQueries({ queryKey: ["projects"] });
    for (const queryKey of [
      ["task"],
      ["task-relations"],
      ["activities"],
      ["notifications"],
    ])
      queryClientRef.invalidateQueries({ queryKey });
  };

  const bulkDelete = useMutation({
    retry: false,
    mutationFn: async (taskIds: string[]) => {
      await fieldOperation({ taskIds, operation: "delete" });
    },
    onSettled: invalidateCommon,
  });

  const bulkArchive = useMutation({
    retry: false,
    mutationFn: async (taskIds: string[]) => {
      await fieldOperation({
        taskIds,
        operation: "updateStatus",
        value: "archived",
      });
    },
    onSettled: invalidateCommon,
  });

  const bulkChangeStatus = useMutation({
    retry: false,
    mutationFn: async ({
      taskIds,
      status,
    }: {
      taskIds: string[];
      status: string;
    }) => {
      await fieldOperation({
        taskIds,
        operation: "updateStatus",
        value: status,
      });
    },
    onSettled: invalidateCommon,
  });

  const bulkAssign = useMutation({
    retry: false,
    mutationFn: async ({
      taskIds,
      userId,
    }: {
      taskIds: string[];
      userId: string;
    }) => {
      await fieldOperation({
        taskIds,
        operation: "updateAssignee",
        value: userId,
      });
    },
    onSettled: invalidateCommon,
  });

  const bulkMoveToBacklog = useMutation({
    retry: false,
    mutationFn: async (taskIds: string[]) => {
      await fieldOperation({
        taskIds,
        operation: "updateStatus",
        value: "planned",
      });
    },
    onSettled: invalidateCommon,
  });

  const bulkMoveToBoard = useMutation({
    retry: false,
    mutationFn: async ({
      taskIds,
      status,
    }: {
      taskIds: string[];
      status: string;
    }) => {
      await fieldOperation({
        taskIds,
        operation: "updateStatus",
        value: status,
      });
    },
    onSettled: invalidateCommon,
  });

  const bulkPriority = useMutation({
    retry: false,
    mutationFn: async ({
      taskIds,
      priority,
    }: {
      taskIds: string[];
      priority: string;
    }) => {
      await fieldOperation({
        taskIds,
        operation: "updatePriority",
        value: priority,
      });
    },
    onSettled: invalidateCommon,
  });

  const bulkAddLabel = useMutation({
    retry: false,
    mutationFn: async ({
      taskIds,
      labelId,
    }: {
      taskIds: string[];
      labelId: string;
    }) => {
      await fieldOperation({
        taskIds,
        operation: "addLabel",
        value: labelId,
      });
    },
    onSettled: () => {
      invalidateCommon();
      queryClientRef.invalidateQueries({ queryKey: ["labels"] });
    },
  });

  const bulkDueDate = useMutation({
    retry: false,
    mutationFn: async ({
      taskIds,
      dueDate,
    }: {
      taskIds: string[];
      dueDate: string | null;
    }) => {
      await fieldOperation({
        taskIds,
        operation: "updateDueDate",
        value: dueDate,
      });
    },
    onSettled: invalidateCommon,
  });

  return {
    bulkDelete: bulkDelete.mutateAsync,
    bulkArchive: bulkArchive.mutateAsync,
    bulkChangeStatus: bulkChangeStatus.mutateAsync,
    bulkAssign: bulkAssign.mutateAsync,
    bulkMoveToBacklog: bulkMoveToBacklog.mutateAsync,
    bulkMoveToBoard: bulkMoveToBoard.mutateAsync,
    bulkPriority: bulkPriority.mutateAsync,
    bulkAddLabel: bulkAddLabel.mutateAsync,
    bulkDueDate: bulkDueDate.mutateAsync,
  };
}
