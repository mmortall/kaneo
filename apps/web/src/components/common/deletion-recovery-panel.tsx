import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  checkPendingDeletion,
  deletionStorageEvent,
  type PendingDeletion,
  pendingDeletions,
} from "@/fetchers/task/delete-operation";

export default function DeletionRecoveryPanel({
  projectId,
}: {
  projectId: string;
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PendingDeletion[]>([]);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    const update = () => {
      try {
        setPending(pendingDeletions(projectId));
      } catch {
        setMessage("Saved deletion results are unavailable in this browser.");
      }
    };
    update();
    window.addEventListener(deletionStorageEvent, update);
    window.addEventListener("storage", update);
    return () => {
      active.current?.abort();
      active.current = null;
      window.removeEventListener(deletionStorageEvent, update);
      window.removeEventListener("storage", update);
    };
  }, [projectId]);
  const check = async () => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    const timer = setTimeout(() => controller.abort(), 20_000);
    setChecking(true);
    setMessage(null);
    let confirmed = 0;
    let missing = 0;
    let failed = 0;
    try {
      for (const operation of pending) {
        if (controller.signal.aborted) break;
        try {
          const result = await checkPendingDeletion(
            operation,
            controller.signal,
          );
          if (result) confirmed += result.deletedCount;
          else missing++;
        } catch {
          failed++;
        }
      }
      if (!controller.signal.aborted) {
        setMessage(
          [
            confirmed
              ? `Deletion confirmed for ${confirmed} task${confirmed === 1 ? "" : "s"}.`
              : "",
            missing
              ? "Some results are not recorded yet. Check again or review tasks before retrying deletion."
              : "",
            failed ? "Some results could not be checked. Try again later." : "",
          ]
            .filter(Boolean)
            .join(" "),
        );
      } else if (active.current === controller) {
        setMessage(
          "Checking timed out. Saved operations remain available; try again later.",
        );
      }
      if (confirmed) {
        for (const key of [
          "task",
          "tasks",
          "projects",
          "task-relations",
          "activities",
          "notifications",
        ])
          void queryClient.invalidateQueries({ queryKey: [key] });
      }
    } finally {
      clearTimeout(timer);
      if (active.current === controller) {
        active.current = null;
        setChecking(false);
      }
    }
  };
  if (!pending.length && !message) return null;
  return (
    <Alert
      variant={pending.length ? "warning" : "info"}
      className="m-2 w-auto shrink-0"
    >
      <AlertTitle>
        {pending.length
          ? `${pending.length} deletion result${pending.length === 1 ? " needs" : "s need"} checking`
          : "Deletion results"}
      </AlertTitle>
      <AlertDescription>
        {message ??
          "Check saved results to find out whether tasks were deleted."}
      </AlertDescription>
      <AlertAction>
        {pending.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            loading={checking}
            onClick={() => void check()}
          >
            Check results
          </Button>
        )}
        {!pending.length && (
          <Button size="sm" variant="ghost" onClick={() => setMessage(null)}>
            Dismiss
          </Button>
        )}
      </AlertAction>
    </Alert>
  );
}
