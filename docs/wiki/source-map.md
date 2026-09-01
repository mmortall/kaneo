# Source map

| Area | Canonical sources | Tests |
| --- | --- | --- |
| Task fields and persistence | `apps/api/src/database/schema.ts`, `apps/api/drizzle/0040_task_category.sql`, `apps/api/drizzle/0041_strategy_horizons.sql` | `tests/api-integration/task.test.ts` |
| Category and horizon contracts | `apps/api/src/task/task-category.ts`, `apps/api/src/task/task-horizon.ts`, `apps/api/src/task/index.ts` | `tests/api-integration/task.test.ts` |
| Personal-board query and route | `apps/web/src/hooks/queries/task/use-get-my-tasks.ts`, `apps/web/src/routes/_layout/_authenticated/dashboard/workspace/$workspaceId/my-tasks.tsx` | Browser verification; model tests below |
| Board grouping and drag/drop | `apps/web/src/components/my-tasks-board/` | `apps/web/src/components/my-tasks-board/model.test.ts` |
| Task editing | `apps/web/src/components/task/task-category-select.tsx`, `apps/web/src/components/task/task-horizons-select.tsx` | `apps/web/src/components/shared/modals/create-task-modal.test.tsx` |
| Agent integration | `apps/api/src/mcp/tools.ts`, `packages/mcp/src/tools/register.ts`, `packages/mcp/src/kaneo/task-helpers.ts` | `packages/mcp/src/tools/register.test.ts`, `packages/mcp/src/kaneo/task-helpers.test.ts` |
| Public API contract | `apps/docs/openapi.json` | JSON parse and API integration tests |
