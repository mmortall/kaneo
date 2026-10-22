import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ capability: vi.fn(), project: vi.fn() }));
vi.mock("@kaneo/libs", () => ({
  client: {
    task: { agent: { capabilities: { $get: mocks.capability } } },
    project: { ":id": { $get: mocks.project } },
  },
}));

import getProject from "./get-project";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.capability.mockResolvedValue(Response.json({ projectSummaries: true }));
  mocks.project.mockResolvedValue(
    Response.json({ id: "project", slug: "PROJ" }),
  );
});
afterEach(() => vi.useRealTimers());

it("requests metadata only and uses one shared abort signal", async () => {
  expect(await getProject({ id: "project", workspaceId: "workspace" })).toEqual(
    { id: "project", slug: "PROJ" },
  );
  expect(mocks.project).toHaveBeenCalledTimes(1);
  expect(mocks.project.mock.calls[0][0]).toEqual({
    param: { id: "project" },
    query: { summary: "true" },
  });
  expect(mocks.project.mock.calls[0][1].init.signal).toBe(
    mocks.capability.mock.calls[0][1].init.signal,
  );
});
it("rejects unsupported servers before requesting a project", async () => {
  mocks.capability.mockResolvedValue(Response.json({}));
  await expect(
    getProject({ id: "project", workspaceId: "workspace" }),
  ).rejects.toThrow("does not support");
  expect(mocks.project).not.toHaveBeenCalled();
});
it("rejects a legacy full-project response", async () => {
  mocks.project.mockResolvedValue(
    Response.json({ id: "project", tasks: [{ description: "large prose" }] }),
  );
  await expect(
    getProject({ id: "project", workspaceId: "workspace" }),
  ).rejects.toThrow("contains task rows");
});
it("cancels pending metadata and clears its deadline", async () => {
  vi.useFakeTimers();
  mocks.project.mockImplementation(
    (_args, options) =>
      new Promise((_resolve, reject) => {
        options.init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  );
  const external = new AbortController();
  const result = getProject(
    { id: "project", workspaceId: "workspace" },
    external.signal,
  );
  const failure = expect(result).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(1);
  external.abort();
  await failure;
  expect(vi.getTimerCount()).toBe(0);
});
it("shares one deadline across capability and metadata requests", async () => {
  vi.useFakeTimers();
  mocks.capability.mockImplementation(
    () =>
      new Promise((resolve) =>
        setTimeout(
          () => resolve(Response.json({ projectSummaries: true })),
          15_000,
        ),
      ),
  );
  mocks.project.mockImplementation(
    (_args, options) =>
      new Promise((_resolve, reject) => {
        options.init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  );
  const failure = expect(
    getProject({ id: "project", workspaceId: "workspace" }),
  ).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(19_999);
  expect(mocks.project).toHaveBeenCalledTimes(1);
  expect(mocks.project.mock.calls[0][1].init.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await failure;
  expect(vi.getTimerCount()).toBe(0);
});
