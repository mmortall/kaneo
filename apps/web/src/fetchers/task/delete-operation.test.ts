import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capability: vi.fn(),
  post: vi.fn(),
  get: vi.fn(),
}));
vi.mock("@kaneo/libs", () => ({
  client: {
    task: {
      agent: {
        capabilities: { $get: mocks.capability },
        delete: {
          ":projectId": { $post: mocks.post, receipt: { $get: mocks.get } },
        },
      },
    },
  },
}));

import { deleteOperation } from "./delete-operation";

const tasks = [{ id: "task", version: 7 }];
const saved = {
  operationId: "a".repeat(64),
  projectId: "project",
  success: true,
  deletedCount: 1,
  taskIds: ["task"],
};
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  mocks.capability.mockImplementation(async () =>
    Response.json({ deleteOperationReceipts: true }),
  );
  mocks.post.mockImplementation(async () => Response.json(saved));
  mocks.get.mockImplementation(async () => Response.json({ receipt: null }));
});
it("recovers committed lost response without second mutation", async () => {
  mocks.post.mockRejectedValue(new TypeError("Lost response"));
  mocks.get.mockImplementation(async () => Response.json({ receipt: saved }));
  await expect(deleteOperation("project", tasks)).resolves.toEqual(saved);
  expect(mocks.post).toHaveBeenCalledOnce();
  expect(mocks.get.mock.calls[0][0].query.key).toBe(
    mocks.post.mock.calls[0][0].json.key,
  );
  expect(sessionStorage.length).toBe(0);
});
it("keeps original key across module reload when receipt recovery is unavailable", async () => {
  mocks.post.mockRejectedValue(new TypeError("Lost response"));
  mocks.get.mockRejectedValue(new TypeError("Offline"));
  await expect(deleteOperation("project", tasks)).rejects.toThrow("uncertain");
  const key = mocks.post.mock.calls[0][0].json.key;
  vi.resetModules();
  const reloaded = await import("./delete-operation");
  mocks.get.mockImplementation(async () => Response.json({ receipt: saved }));
  await expect(reloaded.deleteOperation("project", tasks)).resolves.toEqual(
    saved,
  );
  expect(mocks.post).toHaveBeenCalledOnce();
  expect(mocks.get.mock.calls.at(-1)?.[0].query.key).toBe(key);
  expect(sessionStorage.length).toBe(0);
});
it("manual replay after absent receipt reuses exact key and reviewed revisions", async () => {
  mocks.post.mockResolvedValueOnce(
    new Response("Unavailable", { status: 503 }),
  );
  await expect(deleteOperation("project", tasks)).rejects.toThrow("uncertain");
  await deleteOperation("project", tasks);
  expect(mocks.post.mock.calls[1][0]).toEqual(mocks.post.mock.calls[0][0]);
  expect(mocks.get).toHaveBeenCalledOnce();
});
it("concurrent confirmations reserve same key before capability await", async () => {
  await Promise.all([
    deleteOperation("project", tasks),
    deleteOperation("project", tasks),
  ]);
  expect(mocks.post.mock.calls[0][0].json.key).toBe(
    mocks.post.mock.calls[1][0].json.key,
  );
});
it("never treats malformed or wrong-project receipt as committed proof", async () => {
  mocks.post.mockImplementation(async () =>
    Response.json({ ...saved, projectId: "other" }),
  );
  await expect(deleteOperation("project", tasks)).rejects.toThrow(
    "Invalid deletion receipt",
  );
  expect(sessionStorage.length).toBe(1);
});
it("refuses mutation if operation cannot be persisted", async () => {
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
  try {
    await expect(deleteOperation("project", tasks)).rejects.toThrow(
      "Storage unavailable",
    );
    expect(mocks.post).not.toHaveBeenCalled();
  } finally {
    write.mockRestore();
  }
});
it("does not reuse key when reviewed revision changes", async () => {
  mocks.post.mockResolvedValueOnce(
    new Response("Unavailable", { status: 503 }),
  );
  await expect(deleteOperation("project", tasks)).rejects.toThrow("uncertain");
  await deleteOperation("project", [{ id: "task", version: 8 }]);
  expect(mocks.post.mock.calls[0][0].json.key).not.toBe(
    mocks.post.mock.calls[1][0].json.key,
  );
});
