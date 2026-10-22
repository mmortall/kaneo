import { describe, expect, it, vi } from "vitest";
import { registerTools } from "./register.js";

type RegisteredTool = {
  name: string;
  config: { inputSchema?: { parse: (args: unknown) => unknown } };
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
};

function createServerMock() {
  const tools = new Map<string, RegisteredTool>();

  return {
    server: {
      registerTool: vi.fn(
        (
          name: string,
          config: RegisteredTool["config"],
          handler: RegisteredTool["handler"],
        ) => {
          tools.set(name, { name, config, handler });
        },
      ),
    },
    tools,
  };
}

describe("registerTools", () => {
  it.each([false, true])(
    "passes optional total request %s and preserves continuation",
    async (includeTotal) => {
      const { server, tools } = createServerMock();
      const value = {
        pagination: {
          total: includeTotal ? 100 : null,
          nextPage: 2,
          hasMore: true,
        },
      };
      const client = { json: vi.fn().mockResolvedValue(value) };
      registerTools(server as never, { client: client as never });
      const tool = tools.get("list_tasks")!;
      const args = tool.config.inputSchema!.parse({
        projectId: "project 1",
        includeTotal,
      }) as Record<string, unknown>;
      const result = await tool.handler(args);
      expect(client.json).toHaveBeenCalledWith(
        `/api/task/agent/summary/project%201?includeTotal=${includeTotal}`,
        { method: "GET" },
      );
      expect(JSON.parse(result.content[0]!.text)).toEqual(value);
    },
  );
  it("uses bounded context defaults and preserves explicit truncation and continuation", async () => {
    const { server, tools } = createServerMock();
    const value = {
      task: { id: "task 1" },
      pagination: { nextPage: 2 },
      truncation: { relations: true },
    };
    const client = { json: vi.fn().mockResolvedValue(value) };
    registerTools(server as never, { client: client as never });
    const tool = tools.get("get_task_context")!;
    const args = tool.config.inputSchema!.parse({ taskId: "task 1" }) as Record<
      string,
      unknown
    >;
    const result = await tool.handler(args);
    expect(client.json).toHaveBeenCalledOnce();
    expect(client.json).toHaveBeenCalledWith(
      "/api/task/agent/context/task%201?page=1&limit=25",
    );
    expect(JSON.parse(result.content[0]!.text)).toEqual(value);
    expect(() =>
      tool.config.inputSchema!.parse({ taskId: "task 1", limit: 101 }),
    ).toThrow();
  });
  it("registers the MCP tools", () => {
    const { server } = createServerMock();
    const client = { json: vi.fn() };

    registerTools(server as never, { client: client as never });

    expect(server.registerTool).toHaveBeenCalled();
    expect(server.registerTool).toHaveBeenCalledWith(
      "whoami",
      expect.any(Object),
      expect.any(Function),
    );
    expect(server.registerTool).toHaveBeenCalledWith(
      "update_task",
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("builds the expected query string for list_tasks", async () => {
    const { server, tools } = createServerMock();
    const client = {
      json: vi.fn().mockResolvedValue([{ id: "task-1" }]),
    };

    registerTools(server as never, { client: client as never });

    const result = await tools.get("list_tasks")?.handler({
      projectId: "project 1",
      status: "open",
      page: 2,
      sortOrder: "desc",
    });

    expect(client.json).toHaveBeenCalledWith(
      "/api/task/agent/summary/project%201?status=open&page=2&sortOrder=desc",
      { method: "GET" },
    );
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify([{ id: "task-1" }], null, 2),
        },
      ],
      isError: false,
    });
  });

  it("passes hierarchy and task category fields through task tools", async () => {
    const { server, tools } = createServerMock();
    const client = {
      json: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce({ id: "epic-1" })
        .mockResolvedValueOnce({
          title: "Epic",
          version: 1,
          description: "",
          status: "to-do",
          priority: "medium",
          projectId: "project-1",
          position: 1,
          workItemType: "epic",
          taskCategory: "live_implementation",
          strategyHorizons: ["short"],
        })
        .mockResolvedValueOnce({ id: "epic-1" }),
    };

    registerTools(server as never, { client: client as never });

    await tools.get("list_tasks")?.handler({
      projectId: "project-1",
      workItemType: "epic",
      taskCategory: "research",
    });
    await tools.get("create_task")?.handler({
      projectId: "project-1",
      title: "Epic",
      description: "",
      priority: "medium",
      status: "to-do",
      goal: "Deliver epic outcome",
      acceptanceCriteria: "All epic criteria pass",
      workItemType: "epic",
      taskCategory: "research",
      strategyHorizons: ["position", "long_term"],
    });
    await tools.get("update_task")?.handler({
      taskId: "epic-1",
      expectedVersion: 1,
      workItemType: "sub_epic",
      taskCategory: "agent_blocker",
      strategyHorizons: ["ultra_long_term"],
    });

    expect(client.json).toHaveBeenNthCalledWith(
      1,
      "/api/task/agent/summary/project-1?workItemType=epic&taskCategory=research",
      { method: "GET" },
    );
    expect(JSON.parse(client.json.mock.calls[1]?.[1]?.body)).toMatchObject({
      workItemType: "epic",
      taskCategory: "research",
      strategyHorizons: ["position", "long_term"],
    });
    expect(JSON.parse(client.json.mock.calls[3]?.[1]?.body)).toMatchObject({
      workItemType: "sub_epic",
      taskCategory: "agent_blocker",
      strategyHorizons: ["ultra_long_term"],
    });
    expect(() =>
      tools.get("create_task")?.config.inputSchema?.parse({
        projectId: "project-1",
        title: "Wrong type",
        description: "",
        priority: "medium",
        status: "to-do",
        workItemType: "initiative",
      }),
    ).toThrow();
    expect(() =>
      tools.get("create_task")?.config.inputSchema?.parse({
        projectId: "project-1",
        title: "Wrong category",
        description: "",
        priority: "medium",
        status: "to-do",
        taskCategory: "support",
      }),
    ).toThrow();
    expect(() =>
      tools.get("create_task")?.config.inputSchema?.parse({
        projectId: "project-1",
        title: "Wrong horizon",
        description: "",
        priority: "medium",
        status: "to-do",
        strategyHorizons: ["intraday"],
      }),
    ).toThrow();
  });

  it("fetches the current task and sends only supplied fields with revision for update_task", async () => {
    const { server, tools } = createServerMock();
    const client = {
      json: vi
        .fn()
        .mockResolvedValueOnce({
          title: "Draft spec",
          description: "Write docs",
          status: "open",
          priority: "medium",
          projectId: "project-1",
          position: 4,
          version: 7,
        })
        .mockResolvedValueOnce({ id: "task-1", status: "done" }),
    };

    registerTools(server as never, { client: client as never });

    const result = await tools.get("update_task")?.handler({
      taskId: "task-1",
      expectedVersion: 7,
      status: "done",
    });

    expect(client.json).toHaveBeenNthCalledWith(1, "/api/task/task-1", {
      method: "GET",
    });
    const putCall = client.json.mock.calls[1];
    expect(putCall?.[0]).toBe("/api/task/agent/task-1");
    const putBody = JSON.parse(
      String((putCall?.[1] as { body?: string })?.body ?? "{}"),
    );
    expect(putBody).toEqual({ status: "done", expectedVersion: 7 });
    expect(result?.isError).toBe(false);
  });

  it("fetches the current project and sends a full body for update_project", async () => {
    const { server, tools } = createServerMock();
    const client = {
      json: vi
        .fn()
        .mockResolvedValueOnce({
          name: "Roadmap",
          slug: "roadmap",
        })
        .mockResolvedValueOnce({ id: "project-1", name: "Roadmap v2" }),
    };

    registerTools(server as never, { client: client as never });

    const result = await tools.get("update_project")?.handler({
      id: "project-1",
      name: "Roadmap v2",
    });

    expect(client.json).toHaveBeenNthCalledWith(1, "/api/project/project-1", {
      method: "GET",
    });
    const putCall = client.json.mock.calls[1];
    expect(putCall?.[0]).toBe("/api/project/project-1");
    const putBody = JSON.parse(
      String((putCall?.[1] as { body?: string })?.body ?? "{}"),
    );
    expect(putBody).toEqual({
      name: "Roadmap v2",
      icon: "Layout",
      slug: "roadmap",
      description: "",
      isPublic: false,
    });
    expect(result?.isError).toBe(false);
  });

  it("whoami returns the user without the session token", async () => {
    const { server, tools } = createServerMock();
    const client = {
      json: vi.fn().mockResolvedValue({
        session: { token: "secret-session-token" },
        user: { id: "u1", name: "Ann", email: "ann@example.com", role: null },
      }),
    };

    registerTools(server as never, { client: client as never });

    const result = await tools.get("whoami")?.handler({});

    expect(JSON.stringify(result)).not.toContain("secret-session-token");
    expect(JSON.stringify(result)).toContain("ann@example.com");
  });

  it("returns an MCP error result when the client request fails", async () => {
    const { server, tools } = createServerMock();
    const client = {
      json: vi.fn().mockRejectedValue(new Error("boom")),
    };

    registerTools(server as never, { client: client as never });

    const result = await tools.get("whoami")?.handler({});

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: "boom" }, null, 2),
        },
      ],
      isError: true,
    });
  });

  it("validates label colors as hex values", () => {
    const { server, tools } = createServerMock();
    const client = { json: vi.fn() };

    registerTools(server as never, { client: client as never });

    const schema = tools.get("create_label")?.config.inputSchema;
    expect(schema).toBeDefined();
    expect(() =>
      schema?.parse({
        name: "Bug",
        color: "red",
        workspaceId: "workspace-1",
      }),
    ).toThrow(/hex color/i);
  });

  it("validates task date filters as ISO datetimes with timezone", () => {
    const { server, tools } = createServerMock();
    const client = { json: vi.fn() };

    registerTools(server as never, { client: client as never });

    const schema = tools.get("list_tasks")?.config.inputSchema;
    expect(schema).toBeDefined();
    expect(() =>
      schema?.parse({
        projectId: "project-1",
        dueBefore: "2026-04-04",
      }),
    ).toThrow();
  });

  it("creates a task relation with the expected body", async () => {
    const { server, tools } = createServerMock();
    const client = {
      json: vi.fn().mockResolvedValue({ id: "rel-1", relationType: "blocks" }),
    };

    registerTools(server as never, { client: client as never });

    const result = await tools.get("create_task_relation")?.handler({
      sourceTaskId: "task-1",
      targetTaskId: "task-2",
      relationType: "blocks",
    });

    expect(client.json).toHaveBeenCalledWith("/api/task-relation", {
      method: "POST",
      body: JSON.stringify({
        sourceTaskId: "task-1",
        targetTaskId: "task-2",
        relationType: "blocks",
      }),
    });
    expect(result?.isError).toBe(false);
  });

  it("validates relationType for create_task_relation", () => {
    const { server, tools } = createServerMock();
    const client = { json: vi.fn() };

    registerTools(server as never, { client: client as never });

    const schema = tools.get("create_task_relation")?.config.inputSchema;
    expect(schema).toBeDefined();
    expect(() =>
      schema?.parse({
        sourceTaskId: "task-1",
        targetTaskId: "task-2",
        relationType: "duplicate",
      }),
    ).toThrow();
  });

  it("gets task relations by task id", async () => {
    const { server, tools } = createServerMock();
    const client = { json: vi.fn().mockResolvedValue([]) };

    registerTools(server as never, { client: client as never });

    await tools.get("get_task_relations")?.handler({ taskId: "task 1" });

    expect(client.json).toHaveBeenCalledWith("/api/task-relation/task%201", {
      method: "GET",
    });
  });

  it("deletes a task relation by id", async () => {
    const { server, tools } = createServerMock();
    const client = { json: vi.fn().mockResolvedValue({}) };

    registerTools(server as never, { client: client as never });

    await tools.get("delete_task_relation")?.handler({ id: "rel-1" });

    expect(client.json).toHaveBeenCalledWith("/api/task-relation/rel-1", {
      method: "DELETE",
    });
  });

  it("deletes a task-associated label after a preflight check", async () => {
    const { server, tools } = createServerMock();
    const client = {
      json: vi
        .fn()
        .mockResolvedValueOnce({ id: "label-1", taskId: "task-1" })
        .mockResolvedValueOnce({ id: "label-1" }),
    };

    registerTools(server as never, { client: client as never });

    const result = await tools.get("delete_label")?.handler({ id: "label-1" });

    expect(client.json).toHaveBeenNthCalledWith(1, "/api/label/label-1", {
      method: "GET",
    });
    expect(client.json).toHaveBeenNthCalledWith(2, "/api/label/label-1", {
      method: "DELETE",
    });
    expect(result?.isError).toBe(false);
  });

  it("refuses to delete a workspace label (taskId null)", async () => {
    const { server, tools } = createServerMock();
    const client = {
      json: vi.fn().mockResolvedValue({ id: "label-1", taskId: null }),
    };

    registerTools(server as never, { client: client as never });

    const result = await tools.get("delete_label")?.handler({ id: "label-1" });

    expect(result?.isError).toBe(true);
    expect(client.json).toHaveBeenCalledTimes(1);
    expect(client.json).toHaveBeenCalledWith("/api/label/label-1", {
      method: "GET",
    });
  });
});
