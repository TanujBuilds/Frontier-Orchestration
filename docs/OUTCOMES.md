# Outcome measurement

Use an explicit state root to report the current saved evidence for a Mosaic goal.

```sh
node scripts/mosaic-outcomes.mjs report --state-root /path/to/state --goal GOAL_ID --format markdown
node scripts/mosaic-outcomes.mjs report --state-root /path/to/state --goal GOAL_ID --format json
```

The CLI writes to stdout. It needs an absolute state-root path and a
checkpointed database with no journal sidecars. If a live coordinator owns the database, use its read-only
`outcomes_report` tool instead. The tool reads from the coordinator's existing
connection. SQLite can update its existing shared-memory reader marks while the
persisted database, WAL bytes and execution state stay intact. The tool accepts `goalId`, `projectKey`, `from`, `to`, `limit`, `cursor`
and `format`. Report generation does not contact a provider or run checks.

Omit the goal to select across saved goals, or filter by the stored project key
with `--project`. The key follows Learning's hash of the saved project repository
identifier, falling back to the goal ID for projectless goals. Use `--from` and
`--to` for UTC ISO timestamps. The half-open window selects tasks by creation
time and shows the selected tasks' saved lifecycle as of the read. It is not an
event-window or a historical rewind.

Each snapshot uses one transaction, with 100 tasks per page by default and a
maximum of 500. A report with incomplete coverage describes the returned
evidence only. Inspect JSON coverage and use its continuation cursor with the
same filters. Each continuation reads a new snapshot, so use one complete
snapshot for a project-wide ratio. The reader examines up to 10,000 task
rows, 10,000 event rows, and 10,000 request rows per snapshot. It caps decoded
rows at 2 MiB each and decoded payload at 24 MiB. Goal-level event discovery
uses the most recent 100,000 sequence slots. Large scopes or oversized evidence
can require a narrower filter.

## Reading the numbers

- Attempted counts distinct tasks with saved execution evidence. Repeated
  claims or revisions remain one task. Queued-only work is reported separately.
  Terminal and nonterminal dispositions describe current saved state. The
  acceptance denominator includes unsuccessful and unverified attempts.
- Accepted coding requires matching integration evidence, approved checks and
  the pinned mode's review policy. A check-only mode uses its own acceptance
  route. A passing candidate pending review or integration remains visible.
- Research acceptance requires the supported full-candidate review authority
  and its exact saved evidence bindings. A missing or unsupported authority
  produces an unverified classification. The report has no research launch
  controls.
- Model usage comes from the saved response on each authoritative request ID.
  A captured outcome or stream event can refer to an already counted request.
  Input and output coverage are separate. A genuine zero is recorded usage,
  while absent or invalid fields are unknown. Goal-owned planning requests are
  included only for an explicitly selected, unwindowed goal that fits on the
  first page. Provider detail fields can overlap
  totals. Native host token totals are unknown where Mosaic lacks telemetry.
- Elapsed intervals come from saved clocks and lifecycle evidence, with open
  intervals measured as of the snapshot where known. Per-task intervals can
  overlap. Recorded reviews, revisions and answers reflect saved interactions.
- Comparison is descriptive. The pure `compareOutcomeReports` helper accepts
  2–10 entries of the form `{report, cohort}`. The cohort must supply matching
  `scenario`, `sourcePolicy`, `checkPolicy` and `cohort` labels. The helper
  also checks the saved policy fingerprints. Treat incompatible or incomplete
  cohorts as separate descriptions.

| Evidence | Where to inspect it |
| --- | --- |
| Goal approval, source revision, policy | Goal ID, `goal_get` |
| Task disposition and candidate | Task ID, `task_get` and `task_evidence` |
| Checked integration or full review | Classification evidence references and task evidence |
| Starts, waits, stops and recorded interactions | Event sequence and task ID, `observer_timeline` |
| Reservations, saved responses and recorded usage | Request ID and usage fields in the JSON report |

Corrupt or omitted records produce diagnostics and incomplete or unverified
evidence. A zero eligible denominator gives an unknown ratio. Use the JSON
output for the complete evidence references and the Markdown output for a
compact reading view.

## Disposable demo

```sh
output=$(mktemp -d)
node scripts/mosaic-outcomes.mjs demo --output "$output"
```

The command creates `outcomes.json` and `outcomes.md` in the supplied directory
and refuses to overwrite either file. The demo uses disposable Git and SQLite
state and executes a literal local check. The provider reply and operator
review are simulated. The fixture has two attempted tasks, one queued-only
task, one checked integration and one blocked task. Usage is known for one of
two completed provider requests, with 10 input and 5 output tokens recorded.
