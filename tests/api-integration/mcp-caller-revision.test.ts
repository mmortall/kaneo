import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { registerMcpTools } from "../../apps/api/src/mcp/tools";
import { registerTools } from "../../packages/mcp/src/tools/register";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

type Tool = {
  schema: { parse: (args: unknown) => Record<string, unknown> };
  invoke: (args: Record<string, unknown>) => Promise<{ isError?: boolean }>;
};

describe.each(["standalone", "hosted"])(
  "%s snapshot edits against PostgreSQL",
  (protocol) => {
    beforeEach(resetTestDatabase);

    async function fixture() {
      const member = await createWorkspaceMember({ role: "owner" });
      const { project } = await createProjectFixture({
        workspaceId: member.workspace.id,
      });
      const { project: destination } = await createProjectFixture({
        workspaceId: member.workspace.id,
      });
      mockAuthenticatedSession(member.user);
      const { app } = createApp();
      const headers = {
        "content-type": "application/json",
        "x-kaneo-caller": "ai",
      };
      const created = await app.request(`/api/task/${project.id}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: "Original",
          description: "Original prose",
          status: "to-do",
          priority: "medium",
          goal: "Verify caller revision",
          acceptanceCriteria: "Stale intent rejected",
        }),
      });
      expect(created.status).toBe(200);
      const task = await created.json();
      const tools = new Map<string, Tool>();
      const server = {
        registerTool(
          name: string,
          config: { inputSchema: Tool["schema"] },
          invoke: Tool["invoke"],
        ) {
          tools.set(name, { schema: config.inputSchema, invoke });
        },
      };
      if (protocol === "hosted") {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
          const target = new URL(String(url));
          expect(target.origin).toBe("http://127.0.0.1:5180");
          return app.request(target.pathname + target.search, init);
        });
        registerMcpTools(
          server as never,
          "http://127.0.0.1:5180",
          "isolated-test-token",
        );
      } else {
        registerTools(server as never, {
          client: {
            json: async (path: string, init?: RequestInit) => {
              const response = await app.request(path, {
                ...init,
                headers: { ...headers, ...init?.headers },
              });
              const body = await response.json();
              if (!response.ok) throw new Error(JSON.stringify(body));
              return body;
            },
          } as never,
        });
      }
      const invoke = (name: string, patch: Record<string, unknown>) => {
        const tool = tools.get(name)!;
        return tool.invoke(tool.schema.parse({ taskId: task.id, ...patch }));
      };
      const stored = () =>
        db.query.taskTable.findFirst({
          where: eq(schema.taskTable.id, task.id),
        });
      return { task, invoke, stored, app, headers, destination };
    }

    it.each(["update_task", "update_task_status"])(
      "%s rejects stale agent snapshot without changing newer fields",
      async (name) => {
        const { task, invoke, stored, app, headers } = await fixture();
        const newer = await app.request(`/api/task/agent/${task.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            expectedVersion: task.version,
            title: "Newer edit",
            description: "Newer prose",
            status: "in-progress",
          }),
        });
        expect(newer.status).toBe(200);
        const before = await stored();
        const result = await invoke(name, {
          expectedVersion: task.version,
          ...(name === "update_task"
            ? { title: "Stale replacement" }
            : { status: "to-do" }),
        });
        expect(result.isError).toBe(true);
        expect(await stored()).toEqual(before);
      },
    );

    it("sixteen edits based on same snapshot commit exactly one winner", async () => {
      const { task, invoke, stored } = await fixture();
      const results = await Promise.all(
        Array.from({ length: 16 }, (_, index) =>
          invoke("update_task", {
            expectedVersion: task.version,
            title: `Concurrent ${index}`,
          }),
        ),
      );
      expect(results.filter((result) => !result.isError)).toHaveLength(1);
      expect(results.filter((result) => result.isError)).toHaveLength(15);
      const final = await stored();
      expect(final?.version).toBe(task.version + 1);
      expect(final?.description).toBe("Original prose");
    });

    it("explicit reload and reconciled retry preserve unrelated newer prose", async () => {
      const { task, invoke, stored, app, headers } = await fixture();
      const newer = await app.request(`/api/task/agent/${task.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          expectedVersion: task.version,
          description: "Other agent prose",
        }),
      });
      expect(newer.status).toBe(200);
      expect(
        (
          await invoke("update_task", {
            expectedVersion: task.version,
            title: "My title",
          })
        ).isError,
      ).toBe(true);
      const reloaded = await stored();
      expect(
        (
          await invoke("update_task", {
            expectedVersion: reloaded!.version,
            title: "My reconciled title",
          })
        ).isError,
      ).toBe(false);
      const final = await stored();
      expect(final?.title).toBe("My reconciled title");
      expect(final?.description).toBe("Other agent prose");
      expect(final?.version).toBe(task.version + 2);
    });

    it("stale move leaves both task and destination number unchanged; fresh move succeeds", async () => {
      const { task, invoke, stored, app, headers, destination } =
        await fixture();
      const newer = await app.request(`/api/task/agent/${task.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          expectedVersion: task.version,
          description: "Other agent prose",
        }),
      });
      expect(newer.status).toBe(200);
      const before = await stored();
      const counterBefore = await db.query.projectTable.findFirst({
        where: eq(schema.projectTable.id, destination.id),
      });
      expect(
        (
          await invoke("move_task", {
            expectedVersion: task.version,
            destinationProjectId: destination.id,
          })
        ).isError,
      ).toBe(true);
      expect(await stored()).toEqual(before);
      expect(
        await db.query.projectTable.findFirst({
          where: eq(schema.projectTable.id, destination.id),
        }),
      ).toEqual(counterBefore);
      expect(
        (
          await invoke("move_task", {
            expectedVersion: before!.version,
            destinationProjectId: destination.id,
          })
        ).isError,
      ).toBe(false);
      const final = await stored();
      expect(final?.projectId).toBe(destination.id);
      expect(final?.version).toBe(before!.version + 1);
      expect(final?.description).toBe("Other agent prose");
    });
  },
);
