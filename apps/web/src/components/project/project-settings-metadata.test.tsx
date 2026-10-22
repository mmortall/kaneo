import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Route } from "@/routes/_layout/_authenticated/dashboard/settings/projects/$projectId/general";
import useProjectStore from "@/store/project";

const mocks = vi.hoisted(() => ({
  metadata: vi.fn(),
  legacy: vi.fn(),
  save: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  useNavigate: () => vi.fn(),
  useParams: () => ({ projectId: "project" }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/hooks/queries/project/use-get-project", () => ({
  default: (...args: unknown[]) => mocks.metadata(...args),
}));
vi.mock("@/hooks/queries/task/use-get-tasks", () => ({
  useGetTasks: () => mocks.legacy(),
}));
vi.mock("@/hooks/queries/workspace/use-active-workspace", () => ({
  default: () => ({ data: { id: "workspace" } }),
}));
vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({
    canManageProjects: () => true,
    canDeleteProjects: () => false,
  }),
}));
vi.mock("@/hooks/mutations/project/use-update-project", () => ({
  default: () => ({ mutateAsync: mocks.save }),
}));
vi.mock("@/hooks/mutations/project/use-delete-project", () => ({
  default: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/components/project/tasks-import-export.tsx", () => ({
  TasksImportExport: ({ project }: { project: { id: string } }) => (
    <span>Export {project.id}</span>
  ),
}));
vi.mock("@/components/page-title", () => ({ default: () => null }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const metadata = {
  id: "project",
  name: "Metadata project",
  slug: "META",
  description: "Project description",
  icon: "Layout",
  isPublic: false,
};
const Settings = (Route as unknown as { component: ComponentType }).component;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.metadata.mockReturnValue({ data: metadata });
  mocks.legacy.mockImplementation(() => {
    throw new Error("Settings must not download tasks");
  });
  mocks.save.mockResolvedValue(metadata);
  mocks.invalidate.mockResolvedValue(undefined);
});
afterEach(cleanup);

it("renders project metadata without fetching or replacing board task data", () => {
  const existingBoard = useProjectStore.getState().project;
  render(<Settings />);
  expect(screen.getByDisplayValue("Metadata project")).toBeVisible();
  expect(screen.getByText("Export project")).toBeVisible();
  expect(mocks.metadata).toHaveBeenCalledWith({
    id: "project",
    workspaceId: "workspace",
  });
  expect(mocks.legacy).not.toHaveBeenCalled();
  expect(useProjectStore.getState().project).toBe(existingBoard);
});
it("saves metadata edits without needing task rows", async () => {
  render(<Settings />);
  fireEvent.change(screen.getByDisplayValue("Metadata project"), {
    target: { value: "Renamed project" },
  });
  await waitFor(
    () =>
      expect(mocks.save).toHaveBeenCalledWith({
        id: "project",
        name: "Renamed project",
        slug: "META",
        description: "Project description",
        icon: "Layout",
        isPublic: false,
      }),
    { timeout: 1800 },
  );
  expect(mocks.legacy).not.toHaveBeenCalled();
});
