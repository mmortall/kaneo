Use the host Global Knowledge Platform knowledge base when this fork is checked
out at `externals/kaneo`.

For material API, UI, MCP, migration, release, or test work, first run:

```powershell
.\.ai\kaneo\manage.ps1 start --outcome "<verifiable outcome>" --area "<product area>" --apply
```

This routes work to Kaneo project `Kaneo Fork`. It creates or reuses typed
`Epic -> Sub-epic -> Task` work items. After validation, finish returned leaf
with `.\.ai\kaneo\manage.ps1 finish`. Do not create work for read-only,
status-only, or no-change requests.

The fork has no independent knowledge router. Use host sources first:
`..\..\docs\wiki\index.md`, `..\..\.ai\knowledge.yaml`, and
`..\..\tools\knowledge.ps1`. Kaneo tracks execution state; code, tests, and
host knowledge records remain canonical.
