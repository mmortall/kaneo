# Managed hierarchy preview

Current release retains this contract in `72cf143e8816`. See
[current caller reconciliation](reports/kaneo-current-callers-2026-10-08.md) and
[latest release](reports/kaneo-mcp-caller-revision-release-2026-10-08.json).
Earlier preparation/deployment notes below retain their original evidence dates.

Deployed596f75a2659b, live local/public owned20k canaries pass. Tracking API `kxhgk8mtyi0p9e9qo6grwhn8`, host
`dwopsjvwy7haw4c6xfwdymua`. Requires capability `managedPreview`.

`POST /task/agent/managed/:projectId/preview` accepts exactly same three-item
schema and hierarchy order as ensure. This POST performs reads only, under
repeatable-read/read-only transaction. Workspace is rechecked inside transaction,
after middleware authorization. Creation permission/entitlement is required by
actual ensure, not by advisory read. Existing candidate resolver is shared with
ensure: indexed key, legacy marker and compatible exact-title lookup, each
returning at most two rows. It does not return/download whole project lists.
Legacy marker/title fallback can still scan database rows; no universal constant
SQL-cost or new-index claim is made.

Response contains three proposed task objects and create/reuse/adopt_title
actions. Missing tasks have no fabricated ID/revision. Preview allocates no task
number, edits no descriptions/policy, creates no hierarchy/activity/events and
never reopens final work. Missing status columns, type mismatch, ambiguous title
and conflicting hierarchy return same errors as actual ensure. The plan is
advisory: concurrent changes can invalidate it; actual ensure resolves candidates
again under normal locks. Preview is not a reservation or mutation authorization.

Host nonapply start selects preview only after capability check. New leaf returns
empty direct context; existing leaf gets one bounded context read. No project
list scan and no PATCH/status mutation. Actual ensure path and explicit legacy
compatibility remain available. Preview route is within existing retry-safe
managed POST namespace; conflicts stop without retry/fallback.

## Evidence

-92 host Kaneo tests pass, including real HTTP missing/existing/final leaf,
  single context read, no whole-project call and no conflict fallback.
-22 PostgreSQL cases across preview/managed race/agent suites passed. One initial
  fixture comparison raced earlier ensure event subscribers; tests now drain
  actual event handlers before snapshots and reset, rather than changing product.
-Final preview suite7/7 passes, including workspace recheck inside transaction.
-API typecheck/build and source diff checks pass.
-Read-only live helper scripts/test-managed-preview-live.py prepared for owned
  preserved20k fixture. It will compare project/task/relation/activity SQL
  fingerprints and require three logical calls (capabilities, preview, context).
  Preflight authorization/diagnostics are separately outside measured operation.
  No live preview acceptance claimed before server rollout.

Combined candidate image `kaneo-agent-reliability:20261008-596f75a2659b` contains
preview plus complete lineage batch export. Bundle SHA256
`596f75a2659b63bdc79e0362a5656e11d69d1a5a499d7b43df1ab7b00f70cb1f`
matches isolated no-network image check. Candidate overlay compose-preview.yml,
rollback compose-list.yml, both under .cache/reliability-release. Receipt:
docs/reports/kaneo-caller-release-prepared-2026-10-08.json.
Earlier3e947/734c candidates are superseded preparation artifacts, never deployed.
Public steady session13321 must reach terminal result before API deployment.

That prerequisite completed at00:25:05UTC; production release and both read-only
canaries completed afterward. Current evidence:
docs/reports/kaneo-caller-release-2026-10-08.md. Earlier preparation entries
remain historical, not pending release instructions.
