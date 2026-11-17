# Local redacted support bundle

The source command produces an inspectable JSON diagnostic report for one explicitly selected Mosaic Beta home. Preview is the default. It makes no provider request and starts no coordinator or service.

Use Node 24.22.x from the source checkout:

```sh
node scripts/support/mosaic-support-bundle.mjs --home /absolute/home
```

The installed product exposes the same preview and explicit-home requirement:

```sh
mosaic support-bundle --home /absolute/home
```

To save the same preview locally, first prepare an existing directory you own with mode `0700`, then choose a new filename:

```sh
mkdir -m 700 /absolute/private-support
node scripts/support/mosaic-support-bundle.mjs --home /absolute/home --output /absolute/private-support/bundle.json
```

The command writes the exact sanitized JSON and newline to stdout **before** creating the file. Stdout and file bytes match. It publishes a new `0600` regular file atomically using an exclusive hard link from a private temporary file. Existing files, directories, and symlinks are preserved; no destination is overwritten. Output directories must already exist, be owned by the current user, have no group/other permissions, and have no symlink ancestors. Temporary files are removed on ordinary success or failure. An interrupted process may leave a private temporary file for inspection.

Paths must be absolute and normalized, without control characters. Home and output ancestor symlinks are rejected; use the canonical path on systems with aliases such as `/tmp`. No default home search, core-coordinator discovery, output-directory creation, upload, or installation is performed. The product command also accepts `--output ABS` and the existing leading `mosaic --home ABS support-bundle` form.

Exit status is `0` for a usable preview or completed write, including an offline report; `2` for invalid arguments or a refused write; and `1` for an unexpected collection/format/output failure. Invalid arguments produce only `USAGE: --home ABS [--output ABS]`. Write errors produce `OUTPUT_EXISTS` or `OUTPUT_UNSAFE` after the preview. Other failures produce `SUPPORT_BUNDLE_FAILED`. Errors never repeat input arguments, server messages, or exception text.

A broken preview pipe prevents file creation and returns `1`. If stderr is also unavailable, the numeric status is still returned without an exception stack. Cleanup removes only a temporary file successfully created by that invocation; a colliding pre-existing temporary pathname is preserved.

## Version 1 fields

Every exported field is selected explicitly. Unknown enum values become `unknown`; invalid optional numbers/booleans become `null`. No arbitrary object is copied into the report.

| Field | Meaning |
| --- | --- |
| `schemaVersion`, `kind`, `scope` | Fixed `1`, `mosaic-redacted-support`, `beta-explicit-home`. |
| `collection.status`, `viewerCalls` | `available`, `partial`, or `unavailable` snapshot/timeline collection; attempted viewer calls. This does not assert service health or worker liveness. |
| `limits` | Fixed ceilings listed below, even when an API caller chooses stricter deadlines. |
| `local.settings` | `state`; when reported: schema `1`/`2`, host enum, provider and capacity-group counts up to 16, service concurrency 1–4, execution backend/revision, review source enum. Legacy absent fields stay unknown. |
| `local.installation` | `state`; when reported: schema `1`, numeric release version (optionally `-beta.N`), `contentSha256Present`, `launcherSha256Present`. Digest **values** and shell/PATH text are excluded. Presence is a syntax observation, not integrity verification. |
| `local.setup` | `state`; when reported: schema `1`, boolean `complete`, nullable `manualHost`, host enum. |
| `local.legacyBinding` | `state`; when reported: schema `1`, boolean `complete`. |
| `snapshot.state` | `reported` or `unavailable`; “reported” describes untrusted viewer input projected into the contract. |
| `snapshot.goals` | Processed count and fixed status/mode histograms. |
| `snapshot.tasks` | Processed count and fixed status/actor histograms. Tasks take priority within the combined row ceiling. |
| `snapshot.agents` | Processed count, fixed actor/role histograms, reported `stale` count and `stalenessUnknown` count. No current execution claim is made. |
| `timeline` | `state`; when reported: processed event count and fixed type histogram. Unrecognized types count as `unknown`. |
| `usage` | `nativeTokens: null`, `nativeAccounting: unavailable`; a subtotal of nonnegative safe-integer provider-reported tokens or `null` if no known subtotal; counts of tasks with reported tokens and tasks with unknown tokens. A partial subtotal can increment **both** task counts. Native rows always retain unknown usage, including server-supplied zeroes. These are bounded selected-row observations, not full-job billing. |
| `diagnostics` | Deduplicated fixed codes below. No arbitrary text. |

The host enum is `codex`, `claude-code`, `cursor`, or `antigravity`. Modes are `collaborative`, `deepseek_only`, `codex_only`, or `overnight_review`. Actors are `codex` or `deepseek`. Backend is `darwin-seatbelt` or `codex-sandbox`, revision `1` or `2`; review source is `host` or `api`. Agent roles are `implementer`, `reviewer`, `helper`, `planner`, or `consultant`.

Goal statuses are `draft`, `active`, `completed`, `accepted`, `failed`, `partial`, `cancelled`, and `blocked`. Task statuses are `queued`, `codex_ready`, `suspended`, `running`, `uncertain`, `codex_active`, `awaiting_supervisor`, `awaiting_user`, `awaiting_review`, `awaiting_legacy_review`, `legacy_reviewing`, `blocked`, `ready_to_integrate`, `accepted`, `failed`, `partial`, and `cancelled`. Other values count as `unknown`.

Recognized event types are the following fixed names; no prefix matching admits arbitrary suffixes:

```text
goal.prepared goal.activated goal.finalized
task.submitted task.claimed task.result task.question task.answered
task.reviewed task.integrated task.native_started task.native_finished
task.native_released task.taken_over task.blocked task.uncertain
agent.registered agent.reported help.linked
model.request.started model.request.resolved model.request.completed model.request.failed
coding.edit.proposed coding.edit.applied coding.checks.started coding.checks.passed
coding.checks.failed coding.candidate.saved coding.files.read coding.context.refreshed
coding.context.evicted coding.question execution.yield work.control
request.reserved request.saved
```

## Reads and limits

The collector reads only four allowlisted metadata files under `Library/Application Support/Mosaic Beta/config` in the selected home: `settings.json`, `installation.json`, `portable-binding.json`, and `bindings.json`. Files must be owned private regular files. Metadata reads use a no-follow, nonblocking descriptor and a fixed buffer, reject observed changes, and never traverse arbitrary nested values.

The existing private beta client alone reads the viewer token in memory from `state/viewer-connection.json`. Its unchanged transport validates the literal loopback address and viewer role. This command preflights its path/type/mode/size and uses only:

```text
observer_snapshot {}
observer_timeline {"recent":true,"limit":100}
```

There is no tools discovery, pagination, evidence/artifact request, mutation, provider probe, or database fallback. An older coordinator lacking recent timeline support yields a partial report rather than more calls.

| Resource | Ceiling |
| --- | --- |
| Viewer calls | 2 total |
| Each viewer call | 2,400 ms, including response body |
| Entire collection | 10 seconds, enforced by the parent collector process |
| Recent events processed | 100 |
| Task + agent rows processed | 500 combined |
| Goal rows processed | 100 |
| Each local metadata file | 64 KiB, with a max+1 read to detect overflow |
| Viewer connection | Existing client 8 KiB guard plus this command's preflight |
| Each viewer response | Existing client 8 MiB ceiling, unchanged |
| Sanitized JSON including newline | 256 KiB |

Production collection runs in a short-lived child of the current Node executable. The parent kills an overdue collector and waits for its close before returning a finite `COLLECTION_DEADLINE` report. It creates no detached process. These guards reject unsafe static inputs and observed replacements; they do not claim a filesystem capability boundary against a hostile concurrent writer with the same user identity. In particular the accepted client's original connection-file reader is unchanged. Use an owned local home and private output directory.

Credentials/auth files, setup intents, endpoint/query strings, objectives, IDs, names, model/provider identities, summaries, questions, prompts, source, evidence, raw configuration, raw errors, database/WAL contents, and personal paths are excluded. Credential/auth files and databases are never opened. Input/state/evidence files are never written. Receipt and fixture observations do not establish actual host compatibility, authenticated installation, model operation, clean-Mac readiness, signing, or public release qualification.

## Diagnostic codes

| Codes | Local action |
| --- | --- |
| `LOCAL_HOME_UNAVAILABLE` | Check the explicit canonical home and its ownership; the collector does not create it. |
| `SETTINGS_ABSENT`, `INSTALLATION_ABSENT`, `SETUP_RECEIPT_ABSENT` | The selected metadata is missing. Preserve the report and inspect setup locally if needed. |
| `SETTINGS_INVALID`, `INSTALLATION_INVALID`, `SETUP_RECEIPT_INVALID`, `LOCAL_JSON_INVALID` | Inspect the corresponding original metadata locally; its contents are omitted. |
| `LOCAL_FILE_UNSAFE`, `LOCAL_FILE_TOO_LARGE`, `LOCAL_FILE_CHANGED` | Inspect ownership, permissions, type, size, or concurrent modification. No repair is attempted. |
| `VIEWER_ABSENT`, `VIEWER_CONNECTION_UNSAFE` | No usable private viewer connection was found. Inspect locally; no service is started. |
| `VIEWER_UNAVAILABLE`, `VIEWER_TIMEOUT` | Coordinator response failed, was malformed/oversized, or exceeded its deadline. Preserve the offline/partial report. |
| `SNAPSHOT_INVALID`, `TIMELINE_INVALID` | Viewer JSON does not match the required top-level shape; inspect coordinator compatibility locally. |
| `ROW_LIMIT`, `GOAL_LIMIT`, `EVENT_LIMIT` | Counts cover only the bounded selected subset. |
| `STALE_AGENT_REPORTS` | At least one processed agent was reported stale; no liveness inference is made. |
| `NATIVE_USAGE_UNKNOWN`, `USAGE_INVALID` | Native billing is unavailable, or a numeric subtotal could not be safely aggregated. Never interpret this as zero usage. |
| `COLLECTION_DEADLINE`, `COLLECTOR_FAILED` | Collection did not finish within its bound or exited without a report. A finite fallback report is retained. |

## Module seam

`src/beta/support-bundle.mjs` exports:

- `collectSupportBundle({home}, options)` → a promise of the sanitized schema above. `home` is required. Production uses the bounded child collector. Invalid home/limit/transport arguments reject with fixed `INVALID_HOME`, `INVALID_LIMIT`, or `INVALID_TRANSPORT` codes.
- `formatSupportBundle(bundle)` → the exact pretty JSON plus newline, rejecting `OUTPUT_TOO_LARGE`. Pass only the result of `collectSupportBundle`; the formatter is not a sanitizer for arbitrary objects.
- `runSupportBundle(argv, {stdout, stderr})` → a promise of the numeric exit status. Streams are Node writable streams; this is the entry for an optional later CLI registration.
- `SUPPORT_BUNDLE_LIMITS` → the frozen fixed ceilings.

For owned read-only fixtures, `options.invoke(name,input,signal)` replaces transport and connection access in process. It is trusted test code, must not mutate or call providers, and should honor cancellation for its own handles. `viewerTimeoutMs` and `deadlineMs` may tighten their ceilings, never raise them. Injected transports do not provide the production child-process boundary. No extra CLI flags enable injection or content opt-ins.
