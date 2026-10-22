# Task export contract

Supported web export uses `GET /task/agent/export/:projectId?limit=100`.
Capability `pagedExports: true` identifies this contract.

- Default and maximum page size: 100 tasks. Invalid sizes return 400.
- Follow `pagination.nextCursor` until it is null. Send it as `cursor` on next request.
- Pages use task ID order and keyset continuation, with no project-wide count query.
- Every page validates project/workspace access. Labels are selected only for tasks returned on that page.
- Export includes full task prose, workflow metadata, labels and all statuses, including archived, planned and blocked.
- Web client assembles `{ project, tasks }` using first page's project metadata. Its JSON file remains compatible with existing import.
- Web export has one 300-second deadline across pages. Errors, missing pagination and repeated cursors abort export; no partial file is saved.
- Explicit Python workers can use `client.operation(seconds=300)` while individual requests retain existing 20-second logical and 10-second attempt budgets.

This is a live paginated export, not a transaction snapshot across HTTP requests.
Concurrent deletion before cursor does not shift subsequent pages. Tasks inserted,
moved or edited during export can change the resulting dataset; use a quiet project
when an exact point-in-time copy is required. Browser still holds the completed
file in memory; server no longer loads the whole project for supported web export.

`GET /task/export/:projectId` remains an explicit legacy, unbounded compatibility
endpoint. Repository inventory found one web fetcher and one integration test as
consumers; web fetcher now uses paged endpoint and integration test verifies legacy
compatibility. No scripts, standalone MCP tools or hosted MCP tools reference the
legacy export endpoint in the inspected repository. This does not prove external
clients are absent; retiring compatibility requires caller inventory evidence.

Validation: `tests/api-integration/task-export-pages.test.ts` checks 210-task
completeness, full fields and labels, special statuses, continuation after deletion,
empty results, limits and workspace denial. Web fetcher tests cover assembly,
later-page errors, pagination errors and shared deadline cancellation.
