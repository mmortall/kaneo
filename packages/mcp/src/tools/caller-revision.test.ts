import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMcpTools } from "../../../../apps/api/src/mcp/tools";
import { registerTools } from "./register.js";

type Tool = {
  schema: { parse: (value: unknown) => Record<string, unknown> };
  invoke: (value: Record<string, unknown>) => Promise<{ isError?: boolean }>;
};

afterEach(() => vi.restoreAllMocks());

describe.each(["standalone", "hosted"])(
  "%s caller snapshot revision",
  (protocol) => {
    function setup(versionedMoves = true) {
      const tools = new Map<string, Tool>();
      const writes: Record<string, unknown>[] = [];
      const requests: string[] = [];
      let title = "Newer agent edit";
      const server = {
        registerTool(
          name: string,
          config: { inputSchema: Tool["schema"] },
          invoke: Tool["invoke"],
        ) {
          tools.set(name, { schema: config.inputSchema, invoke });
        },
      };
      const response = (init?: RequestInit, path?: string) => {
        requests.push(init?.method ?? "GET");
        if (path?.endsWith("/task/agent/capabilities"))
          return { status: 200, body: { versionedTaskMoves: versionedMoves } };
        if (init?.method !== "PATCH")
          return {
            status: 200,
            body: { id: "task", version: 8, title, projectId: "project" },
          };
        const payload = JSON.parse(String(init.body));
        writes.push(payload);
        if (payload.expectedVersion !== 8)
          return {
            status: 409,
            body: { error: "TASK_CONFLICT", currentVersion: 8 },
          };
        title = payload.title ?? title;
        return { status: 200, body: { id: "task", version: 9, title } };
      };
      if (protocol === "standalone") {
        registerTools(server as never, {
          client: {
            json: async (path: string, init?: RequestInit) => {
              const value = response(init, path);
              if (value.status !== 200) throw new Error("TASK_CONFLICT");
              return value.body;
            },
          } as never,
        });
      } else {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
          const value = response(init, String(url));
          return new Response(JSON.stringify(value.body), {
            status: value.status,
            headers: { "content-type": "application/json" },
          });
        });
        registerMcpTools(
          server as never,
          "http://127.0.0.1:5180",
          "isolated-test-token",
        );
      }
      return { tools, writes, requests, currentTitle: () => title };
    }

    it.each(["update_task", "update_task_status", "move_task"])(
      "%s requires explicit positive integer revision",
      (name) => {
        const { tools } = setup();
        const tool = tools.get(name)!;
        const args =
          name === "update_task"
            ? { taskId: "task", title: "Old intent" }
            : name === "move_task"
              ? { taskId: "task", destinationProjectId: "destination" }
              : { taskId: "task", status: "to-do" };
        for (const expectedVersion of [undefined, 0, -1, 1.5, "7"]) {
          expect(() =>
            tool.schema.parse({ ...args, expectedVersion }),
          ).toThrow();
        }
        expect(
          tool.schema.parse({ ...args, expectedVersion: 7 }).expectedVersion,
        ).toBe(7);
      },
    );

    it.each(["update_task", "update_task_status"])(
      "%s rejects intent based on stale snapshot",
      async (name) => {
        const { tools, writes, currentTitle } = setup();
        const tool = tools.get(name)!;
        const args = tool.schema.parse({
          taskId: "task",
          expectedVersion: 7,
          ...(name === "update_task"
            ? { title: "Old intent" }
            : { status: "to-do" }),
        });
        const result = await tool.invoke(args);
        expect(result.isError).toBe(true);
        expect(writes).toHaveLength(1);
        expect(writes[0]!.expectedVersion).toBe(7);
        expect(currentTitle()).toBe("Newer agent edit");
      },
    );

    it("refuses move against older API before sending mutation", async () => {
      const { tools, requests } = setup(false);
      const tool = tools.get("move_task")!;
      const result = await tool.invoke(
        tool.schema.parse({
          taskId: "task",
          expectedVersion: 8,
          destinationProjectId: "destination",
        }),
      );
      expect(result.isError).toBe(true);
      expect(requests).toEqual(["GET"]);
    });
  },
);
