# Complete lineage export contract

Current release retains this contract in `72cf143e8816`. See
[current caller reconciliation](reports/kaneo-current-callers-2026-10-08.md) and
[latest release](reports/kaneo-mcp-caller-revision-release-2026-10-08.json).
Earlier preparation/deployment notes below retain their original evidence dates.

Deployed in596f75a2659b; live local/public20k canaries pass. Tracking leaves:
`paqaiscw2vgwx5b54aeaz4cu` (API), `vo80rhmdptsi7ytnv21i0v4t` (host).

Capabilities `exportTaskIdentities` and `projectRelationExports` activate batch
reader. Existing version1 capabilities and legacy export remain compatible.

`GET /task/agent/export/:projectId?limit=100&cursor=<id>` returns stable task ID,
revision, project ID, number, type, position and creation time alongside complete
existing prose/workflow fields. All statuses remain included. Paged priority
preserves database null; legacy export retains low fallback and original shape.

`GET /task/agent/relation-export/:projectId?limit=100&cursor=<id>` returns each
incoming/outgoing edge once, ordered by immutable relation ID. Project access
is checked by existing middleware. Both endpoint projects must belong to
authorized workspace before pagination. Same-workspace cross-project edges
remain included; foreign-workspace and unrelated-project edges are excluded.
Rows contain ID, endpoint IDs, type and creation time without task prose.
Default/max limit100; terminal nextCursor null. No count query/per-task request.

Host uses batch contracts only when both flags are true; older servers retain
compatibility reader. One300s deadline includes capability lookup and every page.
Transport budgets, credentials, route selection and cleanup remain unchanged.
Malformed/oversized pages, duplicate IDs and cyclic/empty continuations fail
collection without returning partial data or falling back after export starts.
Project name, complete prose and task/edge identities remain preserved.

For20k tasks, cost changes from200 task pages plus20k per-task relation reads to
200 task pages plus relation pages and one capability lookup. This is structural
arithmetic, not measured production speedup. Pages are current reads, not one
global snapshot; concurrent insert/delete/move can alter collection. Stable
fixture reconciliation is required. No archival feature is introduced.

Seven PostgreSQL tests cover full fields and206 edges, authorization, uniqueness,
deleted-cursor continuity and invalid bounds. Real HTTP host tests cover complete
batch collection and invalid continuations. API typecheck/build pass; host89 and
lineage8 tests pass. Initial API command failed test DB authentication before
assertions; corrected environment uses isolated kaneo_test. Final null-priority
regression run retained in .cache/reliability-tests/project-relation-export.log.

Do not deploy during public steady session13321. After terminal result, review
source, release API, verify flags and run actual lineage canary on preserved
owned20k fixture, comparing task/edge IDs, history fields and request counts.
Finish both leaves only after that gate and reset release observation baseline.
Deployed build remains3f27c00ac7ee; host uses fallback until capability rollout.

## Prepared release, 2026-10-08

Image `kaneo-agent-reliability:20261008-3e9471553b96` is built from currently
deployed3f27c00ac7ee image, replacing API bundle only. An isolated no-network
container confirmed bundle SHA256
`3e9471553b96964a240dd3cd6c32f86436a4f3563cea5d54a73d8ab4920772ef`.
Web/migrations/dependency runtime inherit deployed image. No production restart.
Candidate overlay `.cache/reliability-release/compose-lineage.yml`; rollback
overlay `.cache/reliability-release/compose-list.yml` retains current image.

Read-only `scripts/test-lineage-batch-export.py --preflight` verified preserved
owned local fixture contains20,018 tasks and33 authorized relations. Baseline
digest `52f9326c09c88e23ea1666b2d11ba701665b62b28e6c94890476c5dc7e008a16`
covers21 full fields, including prose, revisions, workflow and normalized dates.
Receipt `kaneo-lineage-batch-local-20261008T000603Z.json` is preflight only:
`passed=false`, `preflight_passed=true`; actual reader deliberately not run.
Initial preflight used wrong SQL assignee column; corrected from user_id to
schema assignee_id, then preflight passed without any SQL writes.

After deployment run helper for local and dedicated routes. Expected203 logical
reads: one capability lookup,201 full task pages and one relation page. Count
HTTP attempts separately to expose retries; compare all21 fields and edge IDs
against SQL truth. Helper modifies no project/tasks and preserves original
fixture receipt. This canary does not replace final mixed performance gate.

Latest combined candidate is596f75a2659b with read-only managed preview. Use
compose-preview.yml, not earlier batch-only overlay. Earlier3e947 image was never
deployed. Shared source/release receipt and pending gates are recorded in
docs/kaneo-managed-preview-contract.md and kaneo-caller-release-prepared JSON.

Release completed: docs/reports/kaneo-caller-release-2026-10-08.md is current
authority; earlier preparation sections preserve historical sequence only.
