import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { KaneoClient } from "../kaneo/client.js";
import { boundedRegistrar, KaneoRequestError } from "../kaneo/operation.js";
import { errorResult, textResult } from "../utils/mcp-result.js";
import { getCurrentUser } from "./get-current-user.js";

const prioritySchema = z.enum([
  "no-priority",
  "low",
  "medium",
  "high",
  "urgent",
]);
const workItemTypeSchema = z.enum(["task", "epic", "sub_epic"]);
const taskCategorySchema = z.enum([
  "live_implementation",
  "research",
  "agent_blocker",
]);
const taskHorizonSchema = z.enum([
  "short",
  "position",
  "long_term",
  "ultra_long_term",
]);

const nonEmptyString = z.string().trim().min(1);
const optionalNonEmptyString = nonEmptyString.optional();
const nullableOptionalNonEmptyString = nonEmptyString.nullable().optional();
const isoDateTimeSchema = z.string().datetime({ offset: true });
const optionalIsoDateTimeSchema = isoDateTimeSchema.optional();
const nullableOptionalIsoDateTimeSchema = isoDateTimeSchema
  .nullable()
  .optional();
const hexColorSchema = z
  .string()
  .regex(
    /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/,
    "Expected a hex color like #FF6600",
  );

function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  return fn()
    .then((data) => textResult(data))
    .catch((e: unknown) =>
      errorResult(
        e instanceof Error ? e.message : String(e),
        e instanceof KaneoRequestError ? e.details : undefined,
      ),
    );
}

export function registerTools(
  server: McpServer,
  ctx: { client: KaneoClient },
): void {
  const { client } = ctx;
  const registerTool = boundedRegistrar(server);

  registerTool(
    "whoami",
    {
      description: "Return the current Kaneo user for the cached device token.",
      inputSchema: z.object({}),
    },
    async () => run(() => getCurrentUser(client)),
  );

  registerTool(
    "list_workspaces",
    {
      description:
        "List workspaces (Better Auth organizations) the signed-in user can access.",
      inputSchema: z.object({}),
    },
    async () =>
      run(() => client.json("/api/auth/organization/list", { method: "GET" })),
  );

  registerTool(
    "list_projects",
    {
      description: "List projects in a workspace.",
      inputSchema: z.object({
        workspaceId: nonEmptyString.describe("Workspace ID"),
        includeArchived: z
          .boolean()
          .optional()
          .describe("Include archived projects"),
      }),
    },
    async (args) => {
      const { workspaceId, includeArchived } = args;
      const qs = new URLSearchParams({ workspaceId });
      if (includeArchived === true) {
        qs.set("includeArchived", "true");
      }
      return run(() =>
        client.json(`/api/project?${qs.toString()}`, { method: "GET" }),
      );
    },
  );

  registerTool(
    "get_project",
    {
      description: "Get a single project by ID.",
      inputSchema: z.object({ id: nonEmptyString }),
    },
    async (args) =>
      run(() => client.json(`/api/project/${encodeURIComponent(args.id)}`)),
  );

  registerTool(
    "create_project",
    {
      description: "Create a project in a workspace.",
      inputSchema: z.object({
        name: nonEmptyString,
        workspaceId: nonEmptyString,
        icon: nonEmptyString,
        slug: nonEmptyString,
      }),
    },
    async (args) =>
      run(() =>
        client.json("/api/project", {
          method: "POST",
          body: JSON.stringify({
            name: args.name,
            workspaceId: args.workspaceId,
            icon: args.icon,
            slug: args.slug,
          }),
        }),
      ),
  );

  registerTool(
    "update_project",
    {
      description:
        "Update project metadata (PATCH-style: only provided fields are changed).",
      inputSchema: z.object({
        id: nonEmptyString,
        name: optionalNonEmptyString,
        icon: z.string().optional(),
        slug: optionalNonEmptyString,
        description: z.string().optional(),
        isPublic: z.boolean().optional(),
      }),
    },
    async (args) => {
      const { id, ...patch } = args;
      return run(async () => {
        const existing = (await client.json(
          `/api/project/${encodeURIComponent(id)}`,
          { method: "GET" },
        )) as Record<string, unknown>;
        const name =
          patch.name ??
          (typeof existing.name === "string" ? existing.name : "");
        if (!name) {
          throw new Error("Cannot update project: missing name.");
        }
        const icon =
          patch.icon !== undefined
            ? patch.icon
            : typeof existing.icon === "string"
              ? existing.icon
              : "Layout";
        const slug =
          patch.slug ??
          (typeof existing.slug === "string" ? existing.slug : "");
        if (!slug) {
          throw new Error("Cannot update project: missing slug.");
        }
        const description =
          patch.description !== undefined
            ? patch.description
            : typeof existing.description === "string"
              ? existing.description
              : "";
        const isPublic =
          patch.isPublic !== undefined
            ? patch.isPublic
            : typeof existing.isPublic === "boolean"
              ? existing.isPublic
              : false;

        const body = { name, icon, slug, description, isPublic };

        return client.json(`/api/project/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
      });
    },
  );

  const listTasksSchema = z.object({
    projectId: nonEmptyString,
    includeTotal: z.boolean().optional(),
    status: optionalNonEmptyString,
    priority: prioritySchema.optional(),
    assigneeId: optionalNonEmptyString,
    page: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(100).optional(),
    sortBy: z
      .enum(["createdAt", "priority", "dueDate", "position", "title", "number"])
      .optional(),
    sortOrder: z.enum(["asc", "desc"]).optional(),
    dueBefore: optionalIsoDateTimeSchema,
    dueAfter: optionalIsoDateTimeSchema,
    workItemType: workItemTypeSchema.optional(),
    taskCategory: taskCategorySchema.optional(),
    agentReadyOnly: z.boolean().optional(),
    unblockPolicy: z.enum(["ai_allowed", "human_required"]).optional(),
  });

  registerTool(
    "list_tasks",
    {
      description:
        "List bounded task summaries. Follow pagination.nextPage; request includeTotal=true only when exact totals are needed. Use agentReadyOnly and unblockPolicy to select executable work or AI-unblockable blockers.",
      inputSchema: listTasksSchema,
    },
    async (args) => {
      const { projectId, ...rest } = args;
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(rest)) {
        if (v === undefined || v === null) {
          continue;
        }
        qs.set(k, String(v));
      }
      const q = qs.toString();
      const path = `/api/task/agent/summary/${encodeURIComponent(projectId)}${q ? `?${q}` : ""}`;
      return run(() => client.json(path, { method: "GET" }));
    },
  );

  registerTool(
    "get_task",
    {
      description: "Get a task by ID.",
      inputSchema: z.object({ taskId: nonEmptyString }),
    },
    async (args) =>
      run(() =>
        client.json(`/api/task/${encodeURIComponent(args.taskId)}`, {
          method: "GET",
        }),
      ),
  );

  registerTool(
    "create_task",
    {
      description:
        "Create an AI-ready task. For work blocked on a person, use taskCategory=agent_blocker, status=blocked, describe blockedReason, set unblockPolicy=human_required, and assign userId.",
      inputSchema: z.object({
        projectId: nonEmptyString,
        title: nonEmptyString,
        description: z.string(),
        priority: prioritySchema,
        status: nonEmptyString,
        startDate: optionalIsoDateTimeSchema,
        dueDate: optionalIsoDateTimeSchema,
        userId: optionalNonEmptyString,
        workItemType: workItemTypeSchema.optional(),
        taskCategory: taskCategorySchema.optional(),
        strategyHorizons: z.array(taskHorizonSchema).optional(),
        goal: nonEmptyString,
        acceptanceCriteria: nonEmptyString,
        blockedReason: optionalNonEmptyString,
        unblockPolicy: z.enum(["ai_allowed", "human_required"]).optional(),
      }),
    },
    async (args) => {
      const body: Record<string, unknown> = {
        title: args.title,
        description: args.description,
        priority: args.priority,
        status: args.status,
        goal: args.goal,
        acceptanceCriteria: args.acceptanceCriteria,
        blockedReason: args.blockedReason,
        unblockPolicy: args.unblockPolicy,
      };
      if (args.startDate !== undefined) {
        body.startDate = args.startDate;
      }
      if (args.dueDate !== undefined) {
        body.dueDate = args.dueDate;
      }
      if (args.userId !== undefined) {
        body.userId = args.userId;
      }
      if (args.workItemType !== undefined) {
        body.workItemType = args.workItemType;
      }
      if (args.taskCategory !== undefined) {
        body.taskCategory = args.taskCategory;
      }
      if (args.strategyHorizons !== undefined) {
        body.strategyHorizons = args.strategyHorizons;
      }
      return run(() =>
        client.json(`/api/task/${encodeURIComponent(args.projectId)}`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    },
  );

  const updateTaskSchema = z.object({
    taskId: nonEmptyString,
    expectedVersion: z.number().int().positive(),
    title: optionalNonEmptyString,
    description: z.string().nullable().optional(),
    status: optionalNonEmptyString,
    priority: prioritySchema.optional(),
    projectId: optionalNonEmptyString,
    position: z.number().optional(),
    startDate: nullableOptionalIsoDateTimeSchema,
    dueDate: nullableOptionalIsoDateTimeSchema,
    userId: nullableOptionalNonEmptyString,
    workItemType: workItemTypeSchema.optional(),
    taskCategory: taskCategorySchema.optional(),
    strategyHorizons: z.array(taskHorizonSchema).optional(),
    goal: optionalNonEmptyString,
    acceptanceCriteria: optionalNonEmptyString,
    blockedReason: optionalNonEmptyString,
    unblockPolicy: z.enum(["ai_allowed", "human_required"]).optional(),
    completionSummary: optionalNonEmptyString,
    unblockNote: optionalNonEmptyString,
  });

  registerTool(
    "update_task",
    {
      description:
        "Update an AI-ready task using expectedVersion from the task you read. On conflict, reload and reconcile intent. goal and acceptanceCriteria are required when task has no values; human_required blockers cannot be cleared by AI.",
      inputSchema: updateTaskSchema,
    },
    async (args) => {
      const { taskId, ...patch } = args;
      return run(async () => {
        const existing = (await client.json(
          `/api/task/${encodeURIComponent(taskId)}`,
          { method: "GET" },
        )) as Record<string, unknown>;
        if (typeof existing.version !== "number")
          throw new Error("Task revisions unavailable; upgrade Kaneo API");
        if (patch.projectId && patch.projectId !== existing.projectId)
          throw new Error("Use move_task to change project");
        const { projectId: _projectId, ...fields } = patch;
        const body = {
          ...fields,
          ...(fields.userId === null ? { userId: "" } : {}),
          expectedVersion: args.expectedVersion,
        };
        return client.json(`/api/task/agent/${encodeURIComponent(taskId)}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
      });
    },
  );

  registerTool(
    "move_task",
    {
      description:
        "Move a task using expectedVersion from the task you read. On conflict, reload and reconcile intent. AI cannot move human_required blocked tasks without human resolution.",
      inputSchema: z.object({
        taskId: nonEmptyString,
        expectedVersion: z.number().int().positive(),
        destinationProjectId: nonEmptyString,
        destinationStatus: optionalNonEmptyString,
        unblockNote: optionalNonEmptyString,
      }),
    },
    async (args) =>
      run(async () => {
        const capabilities = await client.json<{
          versionedTaskMoves?: boolean;
        }>("/api/task/agent/capabilities", { method: "GET" });
        if (capabilities.versionedTaskMoves !== true)
          throw new Error(
            "Versioned task moves unavailable; upgrade Kaneo API",
          );
        return client.json(
          `/api/task/move/${encodeURIComponent(args.taskId)}`,
          {
            method: "PUT",
            body: JSON.stringify({
              destinationProjectId: args.destinationProjectId,
              expectedVersion: args.expectedVersion,
              ...(args.destinationStatus !== undefined
                ? { destinationStatus: args.destinationStatus }
                : {}),
              ...(args.unblockNote !== undefined
                ? { unblockNote: args.unblockNote }
                : {}),
            }),
          },
        );
      }),
  );

  registerTool(
    "update_task_status",
    {
      description:
        "Update task status using expectedVersion from the task you read. On conflict, reload and reconcile intent. Blocking requires reason and policy; closing requires completionSummary; human_required blockers need a human.",
      inputSchema: z.object({
        taskId: nonEmptyString,
        expectedVersion: z.number().int().positive(),
        status: nonEmptyString,
        goal: optionalNonEmptyString,
        acceptanceCriteria: optionalNonEmptyString,
        blockedReason: optionalNonEmptyString,
        unblockPolicy: z.enum(["ai_allowed", "human_required"]).optional(),
        completionSummary: optionalNonEmptyString,
        unblockNote: optionalNonEmptyString,
      }),
    },
    async (args) =>
      run(async () => {
        const { taskId, ...fields } = args;
        const current = await client.json<Record<string, unknown>>(
          `/api/task/${encodeURIComponent(taskId)}`,
          { method: "GET" },
        );
        if (typeof current.version !== "number")
          throw new Error("Task revisions unavailable; upgrade Kaneo API");
        return client.json(`/api/task/agent/${encodeURIComponent(taskId)}`, {
          method: "PATCH",
          body: JSON.stringify(fields),
        });
      }),
  );
  registerTool(
    "list_task_comments",
    {
      description: "List comments on a task.",
      inputSchema: z.object({ taskId: nonEmptyString }),
    },
    async (args) =>
      run(() =>
        client.json(`/api/comment/${encodeURIComponent(args.taskId)}`, {
          method: "GET",
        }),
      ),
  );

  registerTool(
    "create_task_comment",
    {
      description: "Add a comment to a task.",
      inputSchema: z.object({
        taskId: nonEmptyString,
        content: nonEmptyString,
      }),
    },
    async (args) =>
      run(() =>
        client.json(`/api/comment/${encodeURIComponent(args.taskId)}`, {
          method: "POST",
          body: JSON.stringify({ content: args.content }),
        }),
      ),
  );

  registerTool(
    "update_task_comment",
    {
      description: "Update one of your comments on a task.",
      inputSchema: z.object({
        commentId: nonEmptyString,
        content: nonEmptyString,
      }),
    },
    async (args) =>
      run(() =>
        client.json(`/api/comment/${encodeURIComponent(args.commentId)}`, {
          method: "PUT",
          body: JSON.stringify({ content: args.content }),
        }),
      ),
  );

  registerTool(
    "delete_task_comment",
    {
      description: "Delete one of your comments from a task.",
      inputSchema: z.object({ commentId: nonEmptyString }),
    },
    async (args) =>
      run(() =>
        client.json(`/api/comment/${encodeURIComponent(args.commentId)}`, {
          method: "DELETE",
        }),
      ),
  );

  registerTool(
    "list_workspace_labels",
    {
      description: "List labels defined in a workspace.",
      inputSchema: z.object({ workspaceId: nonEmptyString }),
    },
    async (args) =>
      run(() =>
        client.json(
          `/api/label/workspace/${encodeURIComponent(args.workspaceId)}`,
          { method: "GET" },
        ),
      ),
  );

  registerTool(
    "create_label",
    {
      description:
        "Create a label in a workspace (optionally attach to a task).",
      inputSchema: z.object({
        name: nonEmptyString,
        color: hexColorSchema,
        workspaceId: nonEmptyString,
        taskId: optionalNonEmptyString,
      }),
    },
    async (args) =>
      run(() =>
        client.json("/api/label", {
          method: "POST",
          body: JSON.stringify({
            name: args.name,
            color: args.color,
            workspaceId: args.workspaceId,
            ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
          }),
        }),
      ),
  );

  registerTool(
    "attach_label_to_task",
    {
      description: "Attach an existing label to a task.",
      inputSchema: z.object({
        labelId: nonEmptyString,
        taskId: nonEmptyString,
      }),
    },
    async (args) =>
      run(() =>
        client.json(`/api/label/${encodeURIComponent(args.labelId)}/task`, {
          method: "PUT",
          body: JSON.stringify({ taskId: args.taskId }),
        }),
      ),
  );

  registerTool(
    "detach_label_from_task",
    {
      description: "Detach a label from its current task.",
      inputSchema: z.object({ labelId: nonEmptyString }),
    },
    async (args) =>
      run(() =>
        client.json(`/api/label/${encodeURIComponent(args.labelId)}/task`, {
          method: "DELETE",
        }),
      ),
  );

  registerTool(
    "create_task_relation",
    {
      description:
        "Create a relation between two tasks. relationType: 'subtask' (sourceTaskId is the parent, targetTaskId the child), 'blocks' (sourceTaskId blocks targetTaskId), or 'related' (bidirectional).",
      inputSchema: z.object({
        sourceTaskId: nonEmptyString,
        targetTaskId: nonEmptyString,
        relationType: z.enum(["subtask", "blocks", "related"]),
      }),
    },
    async (args) =>
      run(() =>
        client.json("/api/task-relation", {
          method: "POST",
          body: JSON.stringify({
            sourceTaskId: args.sourceTaskId,
            targetTaskId: args.targetTaskId,
            relationType: args.relationType,
          }),
        }),
      ),
  );

  registerTool(
    "get_task_relations",
    {
      description:
        "List all relations (subtask/blocks/related) involving a task.",
      inputSchema: z.object({ taskId: nonEmptyString }),
    },
    async (args) =>
      run(() =>
        client.json(`/api/task-relation/${encodeURIComponent(args.taskId)}`, {
          method: "GET",
        }),
      ),
  );

  registerTool(
    "get_task_context",
    {
      description:
        "Read bounded task context and authorized ancestors. Follow pagination.nextPage for additional relations; truncation identifies abbreviated fields and omitted linked details.",
      inputSchema: z.object({
        taskId: nonEmptyString,
        page: z.number().int().min(1).default(1),
        limit: z.number().int().min(1).max(100).default(25),
      }),
    },
    async (args) =>
      run(() =>
        client.json(
          `/api/task/agent/context/${encodeURIComponent(args.taskId)}?page=${args.page}&limit=${args.limit}`,
        ),
      ),
  );

  registerTool(
    "delete_task_relation",
    {
      description: "Delete a task relation by its relation ID.",
      inputSchema: z.object({ id: nonEmptyString }),
    },
    async (args) =>
      run(() =>
        client.json(`/api/task-relation/${encodeURIComponent(args.id)}`, {
          method: "DELETE",
        }),
      ),
  );

  registerTool(
    "delete_label",
    {
      description:
        "Delete a label by ID. Only task-associated labels can be deleted; workspace-level labels (taskId null) are rejected by the API.",
      inputSchema: z.object({ id: nonEmptyString }),
    },
    async (args) =>
      run(async () => {
        const label = (await client.json(
          `/api/label/${encodeURIComponent(args.id)}`,
          { method: "GET" },
        )) as { taskId?: string | null };
        if (!label?.taskId) {
          throw new Error(
            "Label is not associated with a task and cannot be deleted (workspace-level labels are not deletable via this endpoint).",
          );
        }
        return client.json(`/api/label/${encodeURIComponent(args.id)}`, {
          method: "DELETE",
        });
      }),
  );
}
