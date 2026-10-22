# Optional counts for agent task summaries

Status: deployed and local/public contract verified. Tracking leaf:
`iwziy37r063zjeejuh9l9d9k`. Current production build:
`agent-reliability-20261008-f56b150a3893`. Release receipt:
`docs/reports/kaneo-summary-count-release-2026-10-08.json`.

`GET /task/agent/summary/:projectId` returns bounded summaries and continuation.
Default requests and `includeTotal=false` skip the aggregate task-count query.
The controller reads at most limit plus one matching rows, removes the extra
row before enrichment and response construction, and returns:

```json
{"pagination":{"total":null,"totalPages":null,"page":1,"pageSize":50,"hasMore":true,"nextPage":2}}
```

Clients follow `nextPage` until null. `includeTotal=true` explicitly requests
exact filtered total and totalPages, with the same hasMore/nextPage fields.
Only literal query values `true` and `false` are accepted. Capability
`summaryOptionalCounts` distinguishes this contract from older deployments.
Both MCP list-task schemas expose optional boolean `includeTotal` and describe
continuation and exact-count opt-in. No client should treat a null total as zero.

Legacy full-task list routes retain counted pagination for existing web/host
consumers. Unpaginated legacy results derive total from rows already fetched;
no redundant count query is needed. This compatibility route remains distinct
from interactive summary lists and explicit paged exports. There is no shared
mutable task cache or pool-size change.

Offset pagination retains existing stable ordering with ID tie-breaker. It is
not a snapshot across concurrent writes. A requested count and page are also
separate queries; no cross-query snapshot guarantee is added.

## Release gates

The prepared-source and preflight entries below are historical evidence. API
deployment and local/public contract canaries subsequently passed; both mixed
pilots passed. Full final-binary steady/24h and interactive OAuth acceptance are
still open. Harness changed only after9585 terminal verification, then frozen
at603fedf4c8a94341ec2b81ef7c7f3970ee5f3791d4ae2c40ddbdc79f578bc88b.

Prepared-source evidence: integration session 22593 exited 0, 30 tests across
agent-list-completeness and agent-reliability passed in 54.67 seconds; retained
log `.cache/reliability-tests/optional-summary-counts-rerun.log`. Initial run
failed only because a test spied on the lazy database Proxy, whose property
descriptor does not expose select; test now observes getDatabase().select.
Original failure log retained separately. MCP register suite: 17 passed. API
typecheck and build passed. Prepared bundle SHA-256:
`f8cbb8843bcf6ec248b06624be0639be8fe91712e27b3eb03c9c5b479ec184e6`.
This hash is not a deployed-image receipt.

Final compatibility change enforces non-null total/totalPages at legacy API
response boundary, preserving generated web-client types without changing web
assets. API and web typechecks pass; standalone MCP build passes. Candidate
image `kaneo-agent-reliability:20261008-f56b150a3893` built and its bundle hash
verified in a disposable container:
`f56b150a3893be4198930a989304b54c7a80c606ed7455886d3ea3ab8d245250`.
Earlier f8cb bundle is superseded, never deployed. Prepared receipt:
`docs/reports/kaneo-summary-count-release-prepared-2026-10-08.json`.
Current production container still has original596f image/start time and is
healthy. No release or observation-window reset has occurred.
Final legacy/summary integration session7459 exited0:19tests passed in36.25s,
including legacy counted API response and filtered partial final summary page.
Retained log `.cache/reliability-tests/optional-counts-legacy-contract.log`.

Deployment verifier `scripts/test-summary-counts-live.py` now prepared. It checks
owned archived fixture/workspace identity and SQL truth, expected build and
capability, default/false/true modes on planned pages2/400/401, complete filtered
epic set, legacy totals, and successful HTTP request-ID echo. Full mode requires
candidate capability/build before contract checks. Every failure after entering
run persists a failed-stage receipt in finally; Python import/argument errors
occur before that scope. Reports contain no task prose or credentials.
Preflight local/public passed on596f, recording capability absent and fixture
20,018/20,000 counts. Receipts:
`kaneo-summary-counts-local-20261008T005113Z.json` and
`kaneo-summary-counts-dedicated-20261008T005145Z.json`.
Preflight is not deployed-contract acceptance; count-query omission is proven
by integration observation, not inferred from null totals alone. py_compile
passed. No mutations, API restarts, or active harness edits performed.

- Complete integration tests for default/false/true count modes, terminal empty
  pages, filters, complete sets, query-count omission, and bounds.
- Keep live mixed-load harness unchanged while session 9585 runs on current
  binary. Before testing a newly deployed build, update its counted-page request
  to includeTotal=true and record new harness hash; do not compare unlike hashes
  without identifying this request-contract change.
- Deploy only after current live stage becomes terminal. Re-run pilots and
  required final-build steady tests; reset observation baseline after deployment.
- Verify authenticated local/public defaults, opt-in count, and capability on
  deployed build before completing this leaf.

Existing callers that depend on summary totals must opt in. Repository
integration tests using totalPages have been updated. The in-flight harness is
the known pending caller edit. Unknown external consumers are not proven
migrated merely by adding this capability.
