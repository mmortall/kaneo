export function formatIssueTitle(taskTitle: string): string {
  return taskTitle;
}

export function formatIssueBody(
  taskDescription: string | null,
  taskId: string,
): string {
  const description = taskDescription || "";

  if (!description.trim()) {
    return `<sub>Task: ${taskId}</sub>`;
  }

  return `${description}

---
<sub>Task: ${taskId}</sub>`;
}

export function formatSyncComment(taskId: string): string {
  return `Task: ${taskId}`;
}

export function getLabelsForIssue(
  priority: string | null,
  status: string,
): string[] {
  const labels: string[] = [];

  if (priority && priority !== "no-priority") {
    labels.push(`priority:${priority}`);
  }

  labels.push(`status:${status}`);

  return labels;
}

export function formatTaskDescriptionFromIssue(
  issueBody: string | null,
  taskId?: string,
): string {
  const body = issueBody || "";
  if (!taskId) return body;
  const footer = `<sub>Task: ${taskId}</sub>`;
  if (body === footer) return "";
  if (!body.endsWith(footer)) return body;
  const prefix = body.slice(0, -footer.length);
  const separator = /(?:\r?\n){2}---\r?\n$/;
  return separator.test(prefix) ? prefix.replace(separator, "") : body;
}
