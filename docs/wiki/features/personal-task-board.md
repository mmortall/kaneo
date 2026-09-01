# Personal task board

## Purpose

`My tasks` is a workspace-level Kanban that aggregates only tasks assigned to the signed-in user across projects in that workspace. The query supplies the current user as `assigneeId`; unassigned tasks and tasks assigned to another user are excluded by the API query. [Source: `apps/web/src/hooks/queries/task/use-get-my-tasks.ts:7-15`; `apps/api/src/task/controllers/get-tasks.ts:105-106`]

The board groups tasks into project columns by status and supports drag-and-drop status changes. Moving a card uses the existing task move endpoint, so the change persists on the underlying project task rather than creating a private copy. [Source: `apps/web/src/components/my-tasks-board/model.ts:22-109`; `apps/web/src/components/my-tasks-board/index.tsx:46-193`; `apps/api/src/task/index.ts:312-350`]

## Work categories

Every task has one work category:

- `live_implementation`
- `research`
- `agent_blocker`

Existing and unspecified tasks default to `live_implementation`. The `My tasks` page exposes one tab per category and shows each category's To Do count. [Source: `apps/api/src/task/task-category.ts:1-7`; `apps/api/src/database/schema.ts:390-394`; `apps/web/src/components/my-tasks-board/model.ts:78-79,145-161`; `apps/web/src/routes/_layout/_authenticated/dashboard/workspace/$workspaceId/my-tasks.tsx:97-122`]

Agents can set the same category through MCP. For work that cannot proceed without a person, MCP guidance uses `agent_blocker` together with blocked status, a reason, a human-required unblock policy, and a human assignee. [Source: `packages/mcp/src/tools/register.ts:204-214,259-271`]

## Strategy horizons

A task can have zero or more strategy horizons:

- `short` — hourly horizon.
- `position` — approximately 2 hours through 1 day, centered around 4 hours.
- `long_term` — 1 day through 1 week.
- `ultra_long_term` — open-ended; typically 1 year or longer.

The API stores horizons as an array and removes duplicates on create, update, and import. The board displays horizon badges and provides a URL-backed single-horizon filter that also scopes tab counts. [Source: `apps/api/src/task/task-horizon.ts:1-13`; `apps/api/src/database/schema.ts:394-399`; `apps/web/src/components/my-tasks-board/task-card.tsx:85-88`; `apps/web/src/routes/_layout/_authenticated/dashboard/workspace/$workspaceId/my-tasks.tsx:34-49,143-167`; `apps/web/src/components/my-tasks-board/model.ts:82-83,145-159`]

## Editing and API coverage

Category and horizons can be set when creating a task and edited later in task properties. They are included in task reads, list filters, import/export, OpenAPI, and MCP create/update tools. [Source: `apps/api/src/task/index.ts:93-98,211-218,379-392,505-524`; `apps/api/src/task/controllers/export-tasks.ts:33-34,96-97`; `apps/web/src/components/task/task-category-select.tsx:26-53`; `apps/web/src/components/task/task-horizons-select.tsx:31-99`; `packages/mcp/src/tools/register.ts:214,270-305,328-329`]

## Verification

Unit tests cover grouping, optimistic status overrides, category filtering, counts, and horizon filtering. PostgreSQL integration tests cover create, list, update, import/export, duplicate normalization, and invalid values. [Source: `apps/web/src/components/my-tasks-board/model.test.ts:74-187`; `tests/api-integration/task.test.ts:303-444`]
