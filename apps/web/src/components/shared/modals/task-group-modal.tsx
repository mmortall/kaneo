import { Archive, ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  prepareTaskGroup,
  type TaskGroupSnapshot,
} from "@/fetchers/task/task-group";
import { TaskConflictError } from "@/fetchers/task/update-task";
import { useApplyTaskGroup } from "@/hooks/mutations/task/use-apply-task-group";
import { toast } from "@/lib/toast";

type TaskGroupModalProps = {
  open: boolean;
  onClose: () => void;
  projectId?: string;
  status?: string;
  action: "archive_column" | "activate_planned";
  destinationName?: string;
};

export function TaskGroupModal({
  open,
  onClose,
  projectId,
  status,
  action,
  destinationName,
}: TaskGroupModalProps) {
  const { t } = useTranslation();
  const apply = useApplyTaskGroup();
  const [snapshot, setSnapshot] = useState<TaskGroupSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let current = true;
    setSnapshot(null);
    setError(null);
    setLoading(false);
    if (open && projectId && status) {
      setLoading(true);
      prepareTaskGroup(
        projectId,
        action === "archive_column"
          ? { action, sourceStatus: status }
          : { action, targetStatus: status },
        crypto.randomUUID(),
      )
        .then((result) => {
          if (current) setSnapshot(result);
        })
        .catch((error) => {
          if (current)
            setError(
              error instanceof Error
                ? error.message
                : "Could not prepare task group",
            );
        })
        .finally(() => {
          if (current) setLoading(false);
        });
    }
    return () => {
      current = false;
    };
  }, [open, projectId, status, action]);
  const taskCount = snapshot?.count ?? 0;
  const isArchive = action === "archive_column";
  const Icon = isArchive ? Archive : ArrowRight;
  const isSingular = taskCount === 1;
  const taskLabel = isArchive
    ? isSingular
      ? "completed task"
      : "completed tasks"
    : isSingular
      ? "planned task"
      : "planned tasks";
  const allLabel = isSingular ? "" : "all ";
  const close = () => {
    if (!apply.isPending) onClose();
  };
  const confirm = async () => {
    if (!snapshot || apply.isPending) return;
    setError(null);
    try {
      const result = await apply.mutateAsync(snapshot);
      toast.success(
        t(
          isArchive ? "tasks:archive.success" : "tasks:backlog.moveAllSuccess",
          { count: result.updatedCount },
        ),
      );
      onClose();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not confirm task group. Retry to check the same operation.",
      );
      if (error instanceof TaskConflictError) setSnapshot(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <DialogContent
        className="max-w-md p-0 overflow-hidden border-border bg-card shadow-2xl"
        showCloseButton={false}
      >
        <div className="p-8">
          <div className="flex flex-col gap-6">
            <DialogHeader className="flex flex-row items-center gap-4 text-left space-y-0 p-0">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 border border-primary/20">
                <Icon className="h-6 w-6 text-primary" />
              </div>
              <DialogTitle className="text-2xl font-bold tracking-tight text-foreground leading-tight">
                {isArchive ? "Archive Tasks" : "Activate Planned Tasks"}
              </DialogTitle>
            </DialogHeader>

            <DialogDescription className="text-base text-muted-foreground leading-relaxed">
              {loading ? (
                "Loading complete task group…"
              ) : snapshot ? (
                <>
                  Are you sure you want to {isArchive ? "archive" : "activate"}{" "}
                  {allLabel}
                  <span className="font-bold text-foreground mx-1">
                    {taskCount}
                  </span>
                  {taskLabel}?{" "}
                  {isArchive
                    ? "This will move them from the active board to your archive."
                    : `This will move them to ${destinationName ?? "the active board"}.`}
                </>
              ) : (
                "Task group preparation is unavailable. Close and reopen this dialog to try again."
              )}
            </DialogDescription>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="border-t border-border bg-muted/30 px-8 py-5 flex flex-row justify-end gap-3">
          <Button
            type="button"
            variant="ghost"
            onClick={close}
            disabled={apply.isPending}
            className="text-muted-foreground hover:text-foreground hover:bg-accent min-w-[80px]"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="default"
            onClick={confirm}
            disabled={
              loading || !snapshot || taskCount === 0 || apply.isPending
            }
            className="shadow-sm min-w-[100px] font-medium"
          >
            {apply.isPending
              ? isArchive
                ? "Archiving…"
                : "Activating…"
              : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
