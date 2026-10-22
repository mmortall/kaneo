import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { taskViewFilters } from "@/lib/task-view-filters";
import LabelFilterPicker from "./label-filter-picker";

const mocks = vi.hoisted(() => ({ page: vi.fn(), legacy: vi.fn() }));
vi.mock("@kaneo/libs", () => ({
  client: {
    label: {
      workspace: {
        ":workspaceId": {
          $get: mocks.legacy,
          catalogue: { $get: mocks.page },
        },
      },
    },
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
  initReactI18next: { type: "3rdParty", init: vi.fn() },
}));
beforeEach(() => {
  mocks.page.mockReset();
  mocks.legacy.mockReset();
  mocks.page.mockImplementation(({ query }) => {
    const rows = Array.from({ length: 51 }, (_, i) => ({
      id: `label-${i}`,
      name: `Label${String(i).padStart(3, "0")}`,
      color: i === 50 ? "red" : "gray",
      isWorkspaceLabel: true,
    })).filter((row) =>
      row.name.toLowerCase().includes(query.search.toLowerCase()),
    );
    const page = Number(query.page);
    const limit = Number(query.limit);
    const total = rows.length;
    const hasMore = page * limit < total;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          items: rows.slice((page - 1) * limit, page * limit),
          pagination: {
            page,
            pageSize: limit,
            total,
            totalPages: Math.ceil(total / limit),
            hasMore,
            nextPage: hasMore ? page + 1 : null,
          },
        }),
      ),
    );
  });
});
afterEach(cleanup);
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Harness() {
    const [selected, setSelected] = useState<string[]>(["saved-individual"]);
    const request = taskViewFilters(
      {
        labels: selected,
        status: null,
        priority: null,
        assignee: null,
        dueDate: null,
      },
      "",
      1,
    );
    return (
      <>
        <LabelFilterPicker
          workspaceId="workspace"
          selected={selected}
          onChange={(values) => setSelected(values ?? [])}
        />
        <output data-testid="request">{JSON.stringify(request)}</output>
      </>
    );
  }
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}
it("loads only open page and retains saved individual selection alongside complete later-page group", async () => {
  mount();
  expect(mocks.page).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "tasks:properties.labels (1)" }),
  );
  await screen.findByText("Label049");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Label050");
  fireEvent.click(screen.getByRole("button", { name: /Label050/ }));
  expect(JSON.parse(screen.getByTestId("request").textContent!)).toMatchObject({
    labels: ["saved-individual"],
    labelGroups: [{ name: "Label050", color: "red" }],
  });
  fireEvent.change(screen.getByRole("searchbox", { name: "Search labels" }), {
    target: { value: "Label010" },
  });
  await screen.findByText("Label010");
  expect(
    JSON.parse(screen.getByTestId("request").textContent!).labelGroups,
  ).toHaveLength(1);
  expect(
    mocks.page.mock.calls.every((call) => Number(call[0].query.limit) <= 50),
  ).toBe(true);
  expect(mocks.legacy).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Clear label filters" }));
  expect(JSON.parse(screen.getByTestId("request").textContent!)).toEqual({});
});
it("keeps selected filters on failed catalogue and retries explicitly", async () => {
  mocks.page.mockRejectedValueOnce(new Error("Catalogue unavailable"));
  mount();
  fireEvent.click(
    screen.getByRole("button", { name: "tasks:properties.labels (1)" }),
  );
  await screen.findByRole("alert");
  expect(JSON.parse(screen.getByTestId("request").textContent!).labels).toEqual(
    ["saved-individual"],
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Label000");
  await waitFor(() => expect(mocks.page).toHaveBeenCalledTimes(2));
  expect(mocks.legacy).not.toHaveBeenCalled();
});
