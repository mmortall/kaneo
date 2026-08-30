import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import {
  assertTaskMutationAllowed,
  assertTaskWorkflowPolicy,
  resolveTaskWorkflowFields,
} from "../../apps/api/src/task/task-workflow-policy";

async function readPolicyError(error: unknown) {
  expect(error).toBeInstanceOf(HTTPException);
  const response = (error as HTTPException).getResponse();
  return (await response.json()) as Record<string, unknown>;
}

describe("task workflow policy", () => {
  it("reports fields required to make AI work task-ready", async () => {
    try {
      assertTaskWorkflowPolicy({
        isAiCaller: true,
        nextStatus: "in-progress",
        fields: {},
      });
      throw new Error("Expected policy rejection");
    } catch (error) {
      await expect(readPolicyError(error)).resolves.toMatchObject({
        error: "TASK_WORKFLOW_POLICY",
        missingFields: ["goal", "acceptanceCriteria"],
        action: "retry with missing fields",
      });
    }
  });

  it("prevents AI mutation when existing task has no goal", async () => {
    try {
      assertTaskMutationAllowed({
        caller: "ai",
        existing: { status: "in-progress", acceptanceCriteria: "Reviewed" },
      });
      throw new Error("Expected policy rejection");
    } catch (error) {
      await expect(readPolicyError(error)).resolves.toMatchObject({
        missingFields: ["goal"],
      });
    }
  });

  it("prevents AI from unblocking a human-required task", async () => {
    try {
      assertTaskWorkflowPolicy({
        isAiCaller: true,
        existing: {
          status: "blocked",
          goal: "Ship report",
          acceptanceCriteria: "Report is validated",
          blockedReason: "Requires legal decision",
          unblockPolicy: "human_required",
        },
        nextStatus: "in-progress",
        fields: {
          goal: "Ship report",
          acceptanceCriteria: "Report is validated",
        },
        unblockNote: "Decision received",
      });
      throw new Error("Expected policy rejection");
    } catch (error) {
      await expect(readPolicyError(error)).resolves.toMatchObject({
        unblockPolicy: "human_required",
        action: "ask a human to unblock the task",
      });
    }
  });

  it("allows AI to unblock only an AI-allowed task with a note", () => {
    expect(() =>
      assertTaskWorkflowPolicy({
        isAiCaller: true,
        existing: {
          status: "blocked",
          goal: "Refresh cache",
          acceptanceCriteria: "Cache matches source",
          blockedReason: "Temporary API outage",
          unblockPolicy: "ai_allowed",
        },
        nextStatus: "in-progress",
        fields: {
          goal: "Refresh cache",
          acceptanceCriteria: "Cache matches source",
        },
        unblockNote: "API is available again",
      }),
    ).not.toThrow();
  });

  it("clears blocker metadata after unblocking", () => {
    expect(
      resolveTaskWorkflowFields(
        {
          status: "blocked",
          goal: "Refresh cache",
          acceptanceCriteria: "Cache matches source",
          blockedReason: "Temporary API outage",
          unblockPolicy: "ai_allowed",
        },
        "in-progress",
        {},
      ),
    ).toMatchObject({ blockedReason: null, unblockPolicy: null });
  });
});
