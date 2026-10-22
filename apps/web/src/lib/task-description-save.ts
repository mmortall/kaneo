import type Task from "@/types/task";

type SavedTask = { id: string; version: number };
type Draft = { task: Task; generation: number };

/** Keep editor revision stable and advance it only after this editor's own commit. */
export function createTaskDescriptionSave(
  save: (task: Task) => Promise<SavedTask>,
  onError: (error: unknown) => void,
  delay = 700,
) {
  let base: Task | undefined;
  let pending: Draft | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let busy = false;
  let blocked = false;
  let ready = false;

  async function flush() {
    if (busy || blocked || !ready || !pending) return;
    const draft = pending;
    pending = undefined;
    ready = false;
    busy = true;
    try {
      const saved = await save(draft.task);
      if (draft.generation !== generation) return;
      if (
        saved.id !== draft.task.id ||
        !Number.isInteger(saved.version) ||
        saved.version !== (draft.task.version ?? 0) + 1
      ) {
        throw new Error("Task changed during save; reload before editing");
      }
      base = { ...draft.task, version: saved.version };
      const queued = pending as Draft | undefined;
      if (queued && queued.generation === generation) {
        // Queued text extends our own draft, never a newly fetched remote snapshot.
        queued.task = { ...queued.task, version: saved.version };
      }
    } catch (error) {
      if (draft.generation === generation) {
        blocked = true;
        pending = undefined;
        clearTimeout(timer);
        onError(error);
      }
    } finally {
      busy = false;
      void flush();
    }
  }

  return {
    hydrate(task: Task) {
      generation += 1;
      clearTimeout(timer);
      pending = undefined;
      blocked = false;
      ready = false;
      base = { ...task };
    },
    schedule(description: string) {
      if (!base || blocked) return;
      pending = { task: { ...base, description }, generation };
      ready = false;
      clearTimeout(timer);
      timer = setTimeout(() => {
        ready = true;
        void flush();
      }, delay);
    },
    isDirty: () => Boolean(pending || busy || blocked),
    canHydrate(task: Task) {
      return (
        !pending &&
        !busy &&
        !blocked &&
        (base?.id !== task.id || (task.version ?? 0) >= (base.version ?? 0))
      );
    },
    cancel() {
      generation += 1;
      clearTimeout(timer);
      pending = undefined;
      base = undefined;
      ready = false;
      blocked = false;
    },
  };
}
