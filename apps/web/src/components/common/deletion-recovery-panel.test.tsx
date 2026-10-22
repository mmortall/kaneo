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

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@kaneo/libs", () => ({
  client: {
    task: {
      agent: {
        delete: {
          ":projectId": {
            $post: mocks.post,
            receipt: { $get: mocks.get },
          },
        },
      },
    },
  },
}));

import { deletionStorageEvent } from "@/fetchers/task/delete-operation";
import DeletionRecoveryPanel from "./deletion-recovery-panel";

const stored = (projectId = "project") =>
  "kaneo-delete-operation:" +
  JSON.stringify([projectId, [{ id: "gone-task", version: 7 }]]);
const receipt = {
  operationId: "a".repeat(64),
  projectId: "project",
  success: true,
  deletedCount: 1,
  taskIds: ["gone-task"],
};
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
});
afterEach(cleanup);
function view(projectId = "project") {
  const client = new QueryClient();
  client.setQueryData(["tasks", "project"], []);
  const result = render(
    <QueryClientProvider client={client}>
      <DeletionRecoveryPanel projectId={projectId} />
    </QueryClientProvider>,
  );
  return { ...result, client };
}
it("recovers saved deletion after reload without task rows or another POST", async () => {
  sessionStorage.setItem(stored(), "saved-key");
  mocks.get.mockImplementation(async () => Response.json({ receipt }));
  const { client } = view();
  fireEvent.click(screen.getByRole("button", { name: "Check results" }));
  await screen.findByText("Deletion confirmed for 1 task.");
  expect(mocks.get.mock.calls[0][0]).toEqual({
    param: { projectId: "project" },
    query: { key: "saved-key" },
  });
  expect(mocks.post).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(stored())).toBeNull();
  expect(client.getQueryState(["tasks", "project"])?.isInvalidated).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByRole("alert")).toBeNull();
});
it("keeps absent receipt pending without assuming deletion or replaying", async () => {
  sessionStorage.setItem(stored(), "saved-key");
  mocks.get.mockImplementation(async () => Response.json({ receipt: null }));
  view();
  fireEvent.click(screen.getByRole("button", { name: "Check results" }));
  await screen.findByText(/Some results are not recorded yet/);
  expect(sessionStorage.getItem(stored())).toBe("saved-key");
  expect(mocks.post).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
});
it("preserves key after failed check and permits read-only retry", async () => {
  sessionStorage.setItem(stored(), "saved-key");
  mocks.get.mockRejectedValueOnce(new TypeError("Offline"));
  mocks.get.mockImplementation(async () => Response.json({ receipt }));
  view();
  fireEvent.click(screen.getByRole("button", { name: "Check results" }));
  await screen.findByText(/Some results could not be checked/);
  expect(sessionStorage.getItem(stored())).toBe("saved-key");
  fireEvent.click(screen.getByRole("button", { name: "Check results" }));
  await screen.findByText("Deletion confirmed for 1 task.");
  expect(mocks.get).toHaveBeenCalledTimes(2);
  expect(mocks.post).not.toHaveBeenCalled();
});
it("shows only current-project operations and updates when deletion is saved", async () => {
  sessionStorage.setItem(stored("other"), "other-key");
  view();
  expect(screen.queryByRole("alert")).toBeNull();
  act(() => {
    sessionStorage.setItem(stored(), "saved-key");
    window.dispatchEvent(new Event(deletionStorageEvent));
  });
  expect(screen.getByText("1 deletion result needs checking")).toBeTruthy();
  expect(mocks.get).not.toHaveBeenCalled();
});
it("aborts pending check when project panel unmounts", async () => {
  sessionStorage.setItem(stored(), "saved-key");
  mocks.get.mockImplementation(
    (_input, options) =>
      new Promise((_resolve, reject) => {
        options.init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  );
  const result = view();
  fireEvent.click(screen.getByRole("button", { name: "Check results" }));
  await waitFor(() => expect(mocks.get).toHaveBeenCalledOnce());
  const signal = mocks.get.mock.calls[0][1].init.signal;
  result.unmount();
  expect(signal.aborted).toBe(true);
  expect(sessionStorage.getItem(stored())).toBe("saved-key");
  expect(mocks.post).not.toHaveBeenCalled();
});
it("bounds whole check to20s and preserves unresolved operation", async () => {
  vi.useFakeTimers();
  try {
    sessionStorage.setItem(stored(), "saved-key");
    mocks.get.mockImplementation(
      (_input, options) =>
        new Promise((_resolve, reject) => {
          options.init.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    view();
    fireEvent.click(screen.getByRole("button", { name: "Check results" }));
    expect(mocks.get).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(screen.getByText(/Checking timed out/)).toBeTruthy();
    expect(sessionStorage.getItem(stored())).toBe("saved-key");
    expect(mocks.post).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
