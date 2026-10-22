import { describe, expect, it } from "vitest";
import {
  formatIssueBody,
  formatIssueTitle,
  formatSyncComment,
  formatTaskDescriptionFromIssue,
  getLabelsForIssue,
} from "../../../../../apps/api/src/plugins/github/utils/format";

describe("github format helpers", () => {
  it("returns the title unchanged", () => {
    expect(formatIssueTitle("Ship notifications")).toBe("Ship notifications");
  });

  it("formats issue bodies with and without a description", () => {
    expect(formatIssueBody(null, "task_123")).toBe("<sub>Task: task_123</sub>");
    expect(formatIssueBody("Body text", "task_123")).toBe(`Body text

---
<sub>Task: task_123</sub>`);
  });

  it("formats sync comments and task descriptions", () => {
    expect(formatSyncComment("task_123")).toBe("Task: task_123");
    expect(formatTaskDescriptionFromIssue("Issue body")).toBe("Issue body");
    expect(formatTaskDescriptionFromIssue(null)).toBe("");
  });

  it("builds labels while skipping no-priority", () => {
    expect(getLabelsForIssue("high", "in-review")).toEqual([
      "priority:high",
      "status:in-review",
    ]);
    expect(getLabelsForIssue("no-priority", "done")).toEqual(["status:done"]);
    expect(getLabelsForIssue(null, "planned")).toEqual(["status:planned"]);
  });
  it.each(["Body", "Line1\nLine2", "Body\n\n", null])(
    "removes matching generated task footer from %s",
    (description) => {
      expect(
        formatTaskDescriptionFromIssue(
          formatIssueBody(description, "task_123"),
          "task_123",
        ),
      ).toBe(description ?? "");
    },
  );
  it("removes matching footer with CRLF delimiter while preserving body line endings", () => {
    const body = "Line1\r\nLine2\r\n\r\n---\r\n<sub>Task: task_123</sub>";
    expect(formatTaskDescriptionFromIssue(body, "task_123")).toBe(
      "Line1\r\nLine2",
    );
  });
  it.each([
    "Body\n\n---\n<sub>Task: another_task</sub>",
    "Body <sub>Task: task_123</sub>",
    "Body\n\n---\n<sub>Task: task_123</sub>\nMore text",
    "Body\n\n---\n<sub>Task: task_123</sub>\n",
  ])("preserves user or nonmatching footer text %s", (body) => {
    expect(formatTaskDescriptionFromIssue(body, "task_123")).toBe(body);
  });
  it("preserves generated footer when linked task identity is unavailable", () => {
    const body = formatIssueBody("Body", "task_123");
    expect(formatTaskDescriptionFromIssue(body)).toBe(body);
  });
});
