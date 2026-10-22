import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ArchiveTasksModal } from "./archive-tasks-modal";
import { TaskGroupModal } from "./task-group-modal";

const mocks = vi.hoisted(() => ({
  capability: vi.fn(),
  prepare: vi.fn(),
  apply: vi.fn(),
  success: vi.fn(),
}));
vi.mock("@kaneo/libs", () => ({
  client: {
    task: {
      agent: {
        capabilities: { $get: mocks.capability },
        "group-prepare": { ":projectId": { $post: mocks.prepare } },
        "group-apply": {
          ":projectId": { ":operationId": { $post: mocks.apply } },
        },
      },
    },
  },
}));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.success } }));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (_key: string, values: unknown) => JSON.stringify(values),
  }),
}));
const snapshot = {
  operationId: "a".repeat(64),
  projectId: "project",
  action: "archive_column",
  sourceStatus: "done",
  targetStatus: "archived",
  count: 10_000,
  expiresAt: "2030-01-01T00:00:00Z",
};
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({
    defaultOptions: { mutations: { retry: 3, retryDelay: 0 } },
  });
  mocks.capability.mockImplementation(async () =>
    Response.json({ completeTaskGroups: true }),
  );
  mocks.prepare.mockImplementation(async () => Response.json(snapshot));
  mocks.apply.mockImplementation(async () =>
    Response.json({ ...snapshot, applied: true, updatedCount: snapshot.count }),
  );
});
afterEach(() => {
  cleanup();
  client.clear();
});
function view(onClose = vi.fn(), sourceStatus = "done") {
  return {
    onClose,
    ...render(
      <QueryClientProvider client={client}>
        <ArchiveTasksModal
          open
          projectId="project"
          sourceStatus={sourceStatus}
          onClose={onClose}
        />
      </QueryClientProvider>,
    ),
  };
}
async function confirm() {
  const button = await screen.findByRole("button", { name: "Confirm" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}
it("reviews complete count and refreshes caches only after one atomic apply", async () => {
  const keys = [
    ["tasks", "project", "view", { page: 7 }],
    ["tasks", "my"],
    ["task", "hidden"],
  ];
  // biome-ignore lint/suspicious/useIterableCallbackReturn: setQueryData result is ignored
  keys.forEach((key) => client.setQueryData(key, { projectId: "project" }));
  const { onClose } = view();
  await screen.findByText("10000");
  expect(mocks.apply).not.toHaveBeenCalled();
  expect(mocks.success).not.toHaveBeenCalled();
  await confirm();
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(mocks.prepare).toHaveBeenCalledOnce();
  expect(mocks.prepare.mock.calls[0][0]).toEqual({
    param: { projectId: "project" },
    json: { action: "archive_column", sourceStatus: "done" },
  });
  expect(
    mocks.prepare.mock.calls[0][1].headers["Idempotency-Key"],
  ).toBeTruthy();
  expect(mocks.apply).toHaveBeenCalledOnce();
  expect(mocks.apply.mock.calls[0][0].param.operationId).toBe(
    snapshot.operationId,
  );
  expect(mocks.success).toHaveBeenCalledWith(JSON.stringify({ count: 10_000 }));
  // biome-ignore lint/suspicious/useIterableCallbackReturn: assertion result is ignored
  keys.forEach((key) =>
    expect(client.getQueryState(key)?.isInvalidated).toBe(true),
  );
});
it("fails closed on old server without sending preparation or apply", async () => {
  mocks.capability.mockResolvedValue(Response.json({}));
  view();
  await screen.findByRole("alert");
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.apply).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
});
it("does not retry lost apply response automatically; manual retry reuses operation", async () => {
  mocks.apply.mockRejectedValueOnce(new TypeError("Connection lost"));
  const { onClose } = view();
  await confirm();
  await screen.findByRole("alert");
  expect(mocks.apply).toHaveBeenCalledOnce();
  expect(mocks.success).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  await confirm();
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(mocks.prepare).toHaveBeenCalledOnce();
  expect(
    mocks.apply.mock.calls.map((call) => call[0].param.operationId),
  ).toEqual([snapshot.operationId, snapshot.operationId]);
});
it.each([409, 410])(
  "requires new review after HTTP %i, without recapturing silently",
  async (status) => {
    mocks.apply.mockResolvedValue(
      Response.json({ message: "changed" }, { status }),
    );
    view();
    await confirm();
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.apply).toHaveBeenCalledOnce();
    expect(mocks.success).not.toHaveBeenCalled();
  },
);
it("blocks duplicate confirmation and closing while server result is pending", async () => {
  let resolve!: (response: Response) => void;
  mocks.apply.mockImplementation(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  const { onClose } = view();
  await confirm();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Archiving…" })).toBeDisabled(),
  );
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(onClose).not.toHaveBeenCalled();
  expect(mocks.success).not.toHaveBeenCalled();
  await act(async () =>
    resolve(
      Response.json({
        ...snapshot,
        applied: true,
        updatedCount: snapshot.count,
      }),
    ),
  );
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});
it("rejects preparation bound to different column", async () => {
  view(vi.fn(), "closed");
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  expect(mocks.apply).not.toHaveBeenCalled();
});

it("ignores late preparation from previous column after dialog scope changes", async () => {
  let resolve!: (response: Response) => void;
  mocks.prepare.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  mocks.prepare.mockImplementationOnce(async () =>
    Response.json({ ...snapshot, sourceStatus: "closed", count: 99 }),
  );
  const { rerender, onClose } = view();
  await waitFor(() => expect(mocks.prepare).toHaveBeenCalledOnce());
  rerender(
    <QueryClientProvider client={client}>
      <ArchiveTasksModal
        open
        projectId="project"
        sourceStatus="closed"
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  await screen.findByText("99");
  await act(async () => resolve(Response.json(snapshot)));
  expect(screen.queryByText("10000")).not.toBeInTheDocument();
  expect(screen.getByText("99")).toBeInTheDocument();
});

it("activates complete planned group with one reviewed operation and server count", async () => {
  const planned = {
    ...snapshot,
    action: "activate_planned",
    sourceStatus: "planned",
    targetStatus: "to-do",
    count: 5000,
  };
  mocks.prepare.mockImplementation(async () => Response.json(planned));
  mocks.apply.mockImplementation(async () =>
    Response.json({ ...planned, applied: true, updatedCount: planned.count }),
  );
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <TaskGroupModal
        open
        projectId="project"
        action="activate_planned"
        status="to-do"
        destinationName="Ready"
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  await screen.findByText("5000");
  expect(screen.getByText(/This will move them to Ready/)).toBeInTheDocument();
  expect(mocks.success).not.toHaveBeenCalled();
  expect(mocks.apply).not.toHaveBeenCalled();
  await confirm();
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(mocks.prepare.mock.calls[0][0].json).toEqual({
    action: "activate_planned",
    targetStatus: "to-do",
  });
  expect(mocks.apply).toHaveBeenCalledOnce();
  expect(mocks.success).toHaveBeenCalledWith(JSON.stringify({ count: 5000 }));
});

it("refuses planned activation response for different destination", async () => {
  mocks.prepare.mockImplementation(async () =>
    Response.json({
      ...snapshot,
      action: "activate_planned",
      sourceStatus: "planned",
      targetStatus: "in-progress",
    }),
  );
  render(
    <QueryClientProvider client={client}>
      <TaskGroupModal
        open
        projectId="project"
        action="activate_planned"
        status="to-do"
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  );
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  expect(mocks.apply).not.toHaveBeenCalled();
});
