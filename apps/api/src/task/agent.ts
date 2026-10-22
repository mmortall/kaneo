import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono-openapi";
import * as v from "valibot";
import { requireEntitlement } from "../billing/require-entitlement-middleware";
import db from "../database";
import {
  projectTable,
  taskOperationTable,
  taskTable,
} from "../database/schema";
import { publishEvent } from "../events";
import { deleteOrphanedAssets } from "../storage/cleanup-assets";
import { requireWorkspacePermission } from "../utils/require-workspace-permission";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import applyTaskGroup from "./controllers/apply-task-group";
import {
  deleteTaskOperation,
  getDeleteReceipt,
} from "./controllers/delete-task-operation";
import ensureManagedTasks from "./controllers/ensure-managed-tasks";
import exportProjectRelations from "./controllers/export-project-relations";
import exportTasks from "./controllers/export-tasks";
import getMyTaskView from "./controllers/get-my-task-view";
import getTaskContext from "./controllers/get-task-context";
import getTasks from "./controllers/get-tasks";
import lockTaskTypeProject from "./controllers/lock-task-type-project";
import orderTask from "./controllers/order-task";
import prepareTaskGroup from "./controllers/prepare-task-group";
import previewManagedTasks from "./controllers/preview-managed-tasks";
import { requireTaskAssigneePermission } from "./controllers/require-task-permission";
import updateTask from "./controllers/update-task";
import { managedItemsSchema, validateManagedHierarchy } from "./managed-spec";
import { TASK_CATEGORIES } from "./task-category";
import { TASK_HORIZONS } from "./task-horizon";
import { taskViewFilterSchema } from "./task-view-filter";
import { TASK_UNBLOCK_POLICIES } from "./task-workflow-policy";
import { VALID_PRIORITIES } from "./validate-task-fields";

const agent = new Hono<{
  Variables: { userId: string; workspaceId?: string; apiKey?: { id: string } };
}>()
  .get("/capabilities", (c) =>
    c.json({
      version: 1,
      managedEnsure: true,
      managedPreview: true,
      taskRevisions: true,
      versionedTaskMoves: true,
      summaryLists: true,
      summaryOptionalCounts: true,
      filteredTaskViews: true,
      labelGroupIdViews: true,
      labelGroupKeyViews: true,
      taskViewExclusions: true,
      scheduledTaskViews: true,
      projectSummaries: true,
      workspaceTaskViews: true,
      relativeTaskOrdering: true,
      versionedBulkTaskFields: true,
      versionedBulkTaskLabels: true,
      versionedBulkTaskDelete: true,
      versionedTaskDelete: true,
      deleteOperationReceipts: true,
      completeTaskGroups: true,
      relationIdempotency: true,
      taskContext: true,
      pagedExports: true,
      exportTaskIdentities: true,
      projectRelationExports: true,
    }),
  )
  .post(
    "/delete/:projectId",
    validator("param", v.object({ projectId: v.string() })),
    validator(
      "json",
      v.object({
        key: v.pipe(v.string(), v.regex(/^[\w:.-]{1,128}$/)),
        tasks: v.pipe(
          v.array(
            v.object({
              id: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
              version: v.pipe(
                v.number(),
                v.integer(),
                v.minValue(1),
                v.maxValue(Number.MAX_SAFE_INTEGER),
              ),
            }),
          ),
          v.minLength(1),
          v.maxLength(100),
        ),
      }),
    ),
    workspaceAccess.fromProject("projectId"),
    requireWorkspacePermission({ task: ["delete"] }),
    async (c) => {
      const { key, tasks } = c.req.valid("json");
      return c.json(
        await deleteTaskOperation(
          c.req.valid("param").projectId,
          c.get("userId"),
          c.get("workspaceId")!,
          key,
          tasks,
        ),
      );
    },
  )
  .get(
    "/delete/:projectId/receipt",
    validator("param", v.object({ projectId: v.string() })),
    validator(
      "query",
      v.object({ key: v.pipe(v.string(), v.regex(/^[\w:.-]{1,128}$/)) }),
    ),
    workspaceAccess.fromProject("projectId"),
    requireWorkspacePermission({ task: ["delete"] }),
    async (c) => {
      const receipt = await getDeleteReceipt(
        c.req.valid("param").projectId,
        c.get("userId"),
        c.get("workspaceId")!,
        c.req.valid("query").key,
      );
      return c.json({ receipt });
    },
  )
  .post(
    "/order/:id",
    validator("param", v.object({ id: v.string() })),
    validator(
      "json",
      v.object({
        projectId: v.string(),
        status: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
        expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
        anchor: v.optional(
          v.object({
            id: v.string(),
            expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
            placement: v.picklist(["before", "after"]),
          }),
        ),
        goal: v.optional(v.string()),
        acceptanceCriteria: v.optional(v.string()),
        blockedReason: v.optional(v.string()),
        unblockPolicy: v.optional(v.picklist(TASK_UNBLOCK_POLICIES)),
        completionSummary: v.optional(v.string()),
        unblockNote: v.optional(v.string()),
      }),
    ),
    workspaceAccess.fromTask(),
    requireWorkspacePermission({ task: ["update"] }),
    requireEntitlement,
    async (c) => {
      const key = c.req.header("Idempotency-Key");
      if (!key || !/^[\w:.-]{1,128}$/.test(key))
        throw new HTTPException(400, {
          message: "Valid Idempotency-Key is required",
        });
      return c.json(
        await orderTask(
          c.req.valid("param").id,
          c.req.valid("json"),
          c.get("userId"),
          c.get("workspaceId")!,
          key,
          c.get("apiKey") ? "ai" : c.req.header("x-kaneo-caller"),
        ),
      );
    },
  )
  .post(
    "/group-prepare/:projectId",
    validator("param", v.object({ projectId: v.string() })),
    validator(
      "json",
      v.variant("action", [
        v.object({
          action: v.literal("archive_column"),
          sourceStatus: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
        }),
        v.object({
          action: v.literal("activate_planned"),
          targetStatus: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
        }),
      ]),
    ),
    workspaceAccess.fromProject("projectId"),
    requireWorkspacePermission({ task: ["update"] }),
    requireEntitlement,
    async (c) =>
      c.json(
        await prepareTaskGroup(
          c.req.valid("param").projectId,
          c.req.valid("json"),
          c.get("userId"),
          c.get("workspaceId")!,
          c.req.header("Idempotency-Key") ?? "",
        ),
      ),
  )
  .post(
    "/group-apply/:projectId/:operationId",
    validator(
      "param",
      v.object({
        projectId: v.string(),
        operationId: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
      }),
    ),
    workspaceAccess.fromProject("projectId"),
    requireWorkspacePermission({ task: ["update"] }),
    requireEntitlement,
    async (c) =>
      c.json(
        await applyTaskGroup(
          c.req.valid("param").projectId,
          c.req.valid("param").operationId,
          c.get("userId"),
          c.get("workspaceId")!,
          c.get("apiKey") ? "ai" : c.req.header("x-kaneo-caller"),
        ),
      ),
  )
  .post(
    "/my-view/:workspaceId",
    validator("param", v.object({ workspaceId: v.string() })),
    validator(
      "json",
      v.object({
        category: v.picklist(TASK_CATEGORIES),
        horizon: v.optional(v.picklist(TASK_HORIZONS)),
        page: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_000_000)),
        ),
        limit: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
        ),
      }),
    ),
    workspaceAccess.fromParam(),
    async (c) => {
      const query = c.req.valid("json");
      return c.json(
        await getMyTaskView(c.req.valid("param").workspaceId, c.get("userId"), {
          ...query,
          page: query.page ?? 1,
          limit: query.limit ?? 50,
        }),
      );
    },
  )
  .post(
    "/view/:projectId",
    validator("param", v.object({ projectId: v.string() })),
    validator(
      "json",
      v.object({
        filters: v.optional(taskViewFilterSchema),
        page: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_000_000)),
        ),
        limit: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
        ),
        sortBy: v.optional(
          v.picklist([
            "createdAt",
            "priority",
            "dueDate",
            "position",
            "title",
            "number",
            "scheduleStart",
          ]),
        ),
        sortOrder: v.optional(v.picklist(["asc", "desc"])),
      }),
    ),
    workspaceAccess.fromProject("projectId"),
    async (c) => {
      const query = c.req.valid("json");
      return c.json(
        await getTasks(c.req.valid("param").projectId, {
          page: query.page ?? 1,
          limit: query.limit ?? 50,
          sortBy: query.sortBy ?? "position",
          sortOrder: query.sortOrder ?? "asc",
          summary: true,
          view: query.filters ?? {},
        }),
      );
    },
  )
  .get(
    "/relation-export/:projectId",
    validator("param", v.object({ projectId: v.string() })),
    validator(
      "query",
      v.object({
        cursor: v.optional(
          v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
        ),
        limit: v.optional(
          v.pipe(
            v.string(),
            v.transform(Number),
            v.integer(),
            v.minValue(1),
            v.maxValue(100),
          ),
        ),
      }),
    ),
    workspaceAccess.fromProject("projectId"),
    async (c) =>
      c.json(
        await exportProjectRelations(
          c.req.valid("param").projectId,
          c.get("workspaceId")!,
          {
            limit: c.req.valid("query").limit ?? 100,
            cursor: c.req.valid("query").cursor,
          },
        ),
      ),
  )
  .get(
    "/export/:projectId",
    validator("param", v.object({ projectId: v.string() })),
    validator(
      "query",
      v.object({
        cursor: v.optional(
          v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
        ),
        limit: v.optional(
          v.pipe(
            v.string(),
            v.transform(Number),
            v.integer(),
            v.minValue(1),
            v.maxValue(100),
          ),
        ),
      }),
    ),
    workspaceAccess.fromProject("projectId"),
    async (c) =>
      c.json(
        await exportTasks(c.req.valid("param").projectId, {
          limit: c.req.valid("query").limit ?? 100,
          cursor: c.req.valid("query").cursor,
        }),
      ),
  )
  .get(
    "/context/:id",
    validator("param", v.object({ id: v.string() })),
    validator(
      "query",
      v.object({
        page: v.optional(
          v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1)),
        ),
        limit: v.optional(
          v.pipe(
            v.string(),
            v.transform(Number),
            v.integer(),
            v.minValue(1),
            v.maxValue(100),
          ),
        ),
      }),
    ),
    workspaceAccess.fromTaskId("id"),
    async (c) =>
      c.json(
        await getTaskContext(
          c.req.valid("param").id,
          c.get("workspaceId")!,
          c.req.valid("query").page ?? 1,
          c.req.valid("query").limit ?? 25,
        ),
      ),
  )
  .post(
    "/managed/:projectId/preview",
    validator("param", v.object({ projectId: v.string() })),
    validator("json", managedItemsSchema),
    workspaceAccess.fromProject("projectId"),
    async (c) => {
      const { items } = c.req.valid("json");
      validateManagedHierarchy(items);
      return c.json(
        await previewManagedTasks(
          c.req.valid("param").projectId,
          c.get("workspaceId")!,
          items,
        ),
      );
    },
  )
  .post(
    "/managed/:projectId",
    validator("param", v.object({ projectId: v.string() })),
    validator("json", managedItemsSchema),
    workspaceAccess.fromProject("projectId"),
    requireWorkspacePermission({ task: ["create", "update"] }),
    requireEntitlement,
    async (c) => {
      const { items } = c.req.valid("json");
      validateManagedHierarchy(items);
      return c.json(
        await ensureManagedTasks(
          c.req.valid("param").projectId,
          items,
          c.get("userId"),
        ),
      );
    },
  )
  .get(
    "/summary/:projectId",
    validator("param", v.object({ projectId: v.string() })),
    validator(
      "query",
      v.object({
        includeTotal: v.optional(
          v.pipe(
            v.picklist(["true", "false"]),
            v.transform((x) => x === "true"),
          ),
        ),
        page: v.optional(
          v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(1)),
        ),
        limit: v.optional(
          v.pipe(
            v.string(),
            v.transform(Number),
            v.integer(),
            v.minValue(1),
            v.maxValue(100),
          ),
        ),
        status: v.optional(v.string()),
        workItemType: v.optional(v.picklist(["task", "epic", "sub_epic"])),
        assigneeId: v.optional(v.string()),
        priority: v.optional(v.string()),
        agentReadyOnly: v.optional(
          v.pipe(
            v.string(),
            v.transform((x) => x === "true"),
          ),
        ),
        unblockPolicy: v.optional(v.string()),
        taskCategory: v.optional(v.picklist(TASK_CATEGORIES)),
        sortBy: v.optional(
          v.picklist([
            "createdAt",
            "priority",
            "dueDate",
            "position",
            "title",
            "number",
          ]),
        ),
        sortOrder: v.optional(v.picklist(["asc", "desc"])),
        dueAfter: v.optional(v.string()),
        dueBefore: v.optional(v.string()),
      }),
    ),
    workspaceAccess.fromProject("projectId"),
    async (c) => {
      return c.json(
        await getTasks(c.req.valid("param").projectId, {
          ...c.req.valid("query"),
          page: c.req.valid("query").page ?? 1,
          limit: c.req.valid("query").limit ?? 50,
          sortBy: c.req.valid("query").sortBy ?? "number",
          summary: true,
        }),
      );
    },
  )
  .patch(
    "/:id",
    validator("param", v.object({ id: v.string() })),
    validator(
      "json",
      v.object({
        expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
        title: v.optional(v.string()),
        description: v.optional(v.string()),
        status: v.optional(v.string()),
        priority: v.optional(v.picklist(VALID_PRIORITIES)),
        position: v.optional(v.number()),
        userId: v.optional(v.string()),
        startDate: v.optional(v.nullable(v.pipe(v.string(), v.isoTimestamp()))),
        dueDate: v.optional(v.nullable(v.pipe(v.string(), v.isoTimestamp()))),
        workItemType: v.optional(v.picklist(["task", "epic", "sub_epic"])),
        taskCategory: v.optional(v.picklist(TASK_CATEGORIES)),
        strategyHorizons: v.optional(v.array(v.picklist(TASK_HORIZONS))),
        goal: v.optional(v.string()),
        acceptanceCriteria: v.optional(v.string()),
        blockedReason: v.optional(v.string()),
        unblockPolicy: v.optional(v.picklist(TASK_UNBLOCK_POLICIES)),
        completionSummary: v.optional(v.string()),
        unblockNote: v.optional(v.string()),
      }),
    ),
    workspaceAccess.fromTask(),
    requireWorkspacePermission({ task: ["update"] }),
    (c, next) =>
      c.req.valid("json").userId === undefined
        ? next()
        : requireTaskAssigneePermission(c, next),
    requireEntitlement,
    async (c) => {
      const patch = c.req.valid("json");
      const id = c.req.valid("param").id;
      let oldStatus = "";
      let oldDescription: string | null = null;
      let replayed = false;
      const key = c.req.header("Idempotency-Key");
      if (key && !/^[\w:.-]{1,128}$/.test(key))
        throw new HTTPException(400, { message: "Invalid Idempotency-Key" });
      const operationId = key
        ? createHash("sha256")
            .update(`${c.get("userId")}:${id}:${key}`)
            .digest("hex")
        : undefined;
      const bodyHash = createHash("sha256")
        .update(JSON.stringify(patch))
        .digest("hex");
      const task = await db.transaction(async (tx) => {
        const lockedProject =
          patch.workItemType === undefined
            ? undefined
            : await lockTaskTypeProject(tx, id, c.get("workspaceId"));
        const [current] = await tx
          .select()
          .from(taskTable)
          .where(eq(taskTable.id, id))
          .for("update");
        if (!current)
          throw new HTTPException(404, { message: "Task not found" });
        if (lockedProject && current.projectId !== lockedProject)
          throw new HTTPException(409, {
            message:
              "Task moved during type validation; reload before retrying",
          });
        const [authorized] = await tx
          .select({ id: projectTable.id })
          .from(projectTable)
          .where(
            and(
              eq(projectTable.id, current.projectId),
              eq(projectTable.workspaceId, c.get("workspaceId")!),
            ),
          );
        if (!authorized)
          throw new HTTPException(409, {
            message: "Task workspace changed; reload before retrying",
          });
        if (operationId) {
          const [operation] = await tx
            .select()
            .from(taskOperationTable)
            .where(eq(taskOperationTable.id, operationId));
          if (operation) {
            if (operation.bodyHash !== bodyHash)
              throw new HTTPException(409, {
                message: "Idempotency key reused with different payload",
              });
            replayed = true;
            return operation.result as typeof current;
          }
        }
        if (current.version !== patch.expectedVersion)
          throw new HTTPException(409, {
            res: new Response(
              JSON.stringify({
                error: "TASK_CONFLICT",
                currentVersion: current.version,
              }),
              { status: 409, headers: { "content-type": "application/json" } },
            ),
          });
        oldStatus = current.status;
        oldDescription = current.description;
        const start =
          patch.startDate === undefined
            ? current.startDate
            : patch.startDate === null
              ? null
              : new Date(patch.startDate);
        const due =
          patch.dueDate === undefined
            ? current.dueDate
            : patch.dueDate === null
              ? null
              : new Date(patch.dueDate);
        if (start && due && start > due)
          throw new HTTPException(400, {
            message: "Start date must not be after due date",
          });
        const updated = await updateTask(
          id,
          patch.title ?? current.title,
          patch.status ?? current.status,
          start ?? undefined,
          due ?? undefined,
          current.projectId,
          patch.description ?? current.description,
          patch.priority ?? current.priority,
          patch.position ?? current.position,
          patch.userId ?? current.userId ?? undefined,
          patch.workItemType,
          patch.taskCategory,
          patch.strategyHorizons,
          c.get("userId"),
          patch,
          c.get("apiKey") ? "ai" : c.req.header("x-kaneo-caller"),
          {
            database: tx,
            expectedVersion: patch.expectedVersion,
            skipEvents: true,
            partialFields: Object.keys(patch).filter(
              (field) => patch[field as keyof typeof patch] !== undefined,
            ),
          },
        );
        if (operationId)
          await tx.insert(taskOperationTable).values({
            id: operationId,
            taskId: id,
            bodyHash,
            result: JSON.parse(JSON.stringify(updated)),
          });
        return updated;
      });
      if (replayed) return c.json(task);
      if (oldDescription !== task.description) {
        deleteOrphanedAssets(oldDescription, task.description ?? "", {
          taskId: id,
        }).catch(() => {});
      }
      if (oldStatus !== task.status) {
        await publishEvent("task.status_changed", {
          taskId: id,
          projectId: task.projectId,
          userId: c.get("userId"),
          oldStatus,
          newStatus: task.status,
          title: task.title,
          assigneeId: task.userId,
          type: "status_changed",
        });
        await publishEvent("task-relation.refresh", {
          projectId: task.projectId,
          userId: c.get("userId"),
        });
      }
      await publishEvent("task.updated", {
        taskId: id,
        projectId: task.projectId,
        userId: c.get("userId"),
        title: task.title,
        status: task.status,
      });
      return c.json(task);
    },
  );

export default agent;
