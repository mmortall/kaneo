import { TaskGroupModal } from "./task-group-modal";

type ArchiveTasksModalProps = {
  open: boolean;
  onClose: () => void;
  projectId?: string;
  sourceStatus?: string;
};

export function ArchiveTasksModal({
  sourceStatus,
  ...props
}: ArchiveTasksModalProps) {
  return (
    <TaskGroupModal {...props} action="archive_column" status={sourceStatus} />
  );
}
