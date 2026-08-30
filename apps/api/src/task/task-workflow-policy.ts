import { HTTPException } from "hono/http-exception";

export const TASK_UNBLOCK_POLICIES = ["ai_allowed", "human_required"] as const;

export type TaskUnblockPolicy = (typeof TASK_UNBLOCK_POLICIES)[number];

export type TaskWorkflowFields = {
  goal?: string | null;
  acceptanceCriteria?: string | null;
  blockedReason?: string | null;
  unblockPolicy?: string | null;
  completionSummary?: string | null;
};

type ExistingTaskWorkflowFields = TaskWorkflowFields & {
  status: string;
};

function normalize(value: string | null | undefined) {
  return value?.trim() || null;
}

function throwPolicyError(
  message: string,
  details: Record<string, unknown>,
): never {
  const body = JSON.stringify({
    error: "TASK_WORKFLOW_POLICY",
    message,
    ...details,
  });

  throw new HTTPException(409, {
    message,
    res: new Response(body, {
      status: 409,
      headers: { "Content-Type": "application/json" },
    }),
  });
}

export function isAiTaskCaller(caller: string | undefined) {
  return caller?.trim().toLowerCase() === "ai";
}

/**
 * Enforces fields needed for agent-ready work and safe status transitions.
 * Human UI edits remain backward-compatible; MCP marks its requests as AI.
 */
export function assertTaskWorkflowPolicy({
  isAiCaller,
  existing,
  nextStatus,
  isFinalStatus = nextStatus === "done",
  fields,
  unblockNote,
}: {
  isAiCaller: boolean;
  existing?: ExistingTaskWorkflowFields;
  nextStatus: string;
  isFinalStatus?: boolean;
  fields: TaskWorkflowFields;
  unblockNote?: string | null;
}) {
  const goal = normalize(fields.goal);
  const acceptanceCriteria = normalize(fields.acceptanceCriteria);
  const completionSummary = normalize(fields.completionSummary);
  const blockedReason = normalize(fields.blockedReason);
  const unblockPolicy = normalize(fields.unblockPolicy);

  if (isAiCaller) {
    const missingFields: string[] = [];
    if (!goal) missingFields.push("goal");
    if (!acceptanceCriteria) missingFields.push("acceptanceCriteria");

    if (missingFields.length > 0) {
      throwPolicyError(
        "AI task operation requires an explicit goal and acceptance criteria.",
        {
          missingFields,
          action: "retry with missing fields",
        },
      );
    }
  }

  if (nextStatus === "blocked" && isAiCaller) {
    const missingFields: string[] = [];
    if (!blockedReason) missingFields.push("blockedReason");
    if (!unblockPolicy) missingFields.push("unblockPolicy");

    if (missingFields.length > 0) {
      throwPolicyError(
        "Blocking an AI task requires reason and an unblocking policy.",
        {
          missingFields,
          allowedUnblockPolicies: TASK_UNBLOCK_POLICIES,
          action: "retry with blocker metadata",
        },
      );
    }
  }

  if (isFinalStatus && isAiCaller && !completionSummary) {
    throwPolicyError(
      "Closing an AI task requires a completion summary proving the result.",
      {
        missingFields: ["completionSummary"],
        action: "retry with completion summary",
      },
    );
  }

  if (
    isAiCaller &&
    existing?.status === "blocked" &&
    nextStatus !== "blocked" &&
    (existing.unblockPolicy ?? "human_required") === "human_required"
  ) {
    throwPolicyError("This task is blocked until a human resolves it.", {
      action: "ask a human to unblock the task",
      unblockPolicy: "human_required",
      blockedReason: existing.blockedReason ?? null,
    });
  }

  if (
    isAiCaller &&
    existing?.status === "blocked" &&
    nextStatus !== "blocked" &&
    !normalize(unblockNote)
  ) {
    throwPolicyError("Unblocking an AI task requires a resolution note.", {
      missingFields: ["unblockNote"],
      action: "retry with resolution note",
    });
  }
}

export function assertTaskMutationAllowed({
  caller,
  existing,
}: {
  caller?: string;
  existing: ExistingTaskWorkflowFields;
}) {
  assertTaskWorkflowPolicy({
    isAiCaller: isAiTaskCaller(caller),
    existing,
    nextStatus: existing.status,
    isFinalStatus: existing.status === "done",
    fields: existing,
  });
}

export function resolveTaskWorkflowFields(
  existing: ExistingTaskWorkflowFields | undefined,
  nextStatus: string,
  fields: TaskWorkflowFields,
) {
  const resolved = {
    goal:
      fields.goal !== undefined
        ? normalize(fields.goal)
        : (existing?.goal ?? null),
    acceptanceCriteria:
      fields.acceptanceCriteria !== undefined
        ? normalize(fields.acceptanceCriteria)
        : (existing?.acceptanceCriteria ?? null),
    blockedReason:
      nextStatus === "blocked"
        ? fields.blockedReason !== undefined
          ? normalize(fields.blockedReason)
          : (existing?.blockedReason ?? "Blocked without a recorded reason")
        : null,
    unblockPolicy:
      nextStatus === "blocked"
        ? fields.unblockPolicy !== undefined
          ? normalize(fields.unblockPolicy)
          : (existing?.unblockPolicy ?? "human_required")
        : null,
    completionSummary:
      fields.completionSummary !== undefined
        ? normalize(fields.completionSummary)
        : (existing?.completionSummary ?? null),
  };

  if (
    resolved.unblockPolicy !== null &&
    !TASK_UNBLOCK_POLICIES.includes(resolved.unblockPolicy as TaskUnblockPolicy)
  ) {
    throwPolicyError("Invalid task unblock policy.", {
      field: "unblockPolicy",
      allowedValues: TASK_UNBLOCK_POLICIES,
    });
  }

  return resolved;
}
