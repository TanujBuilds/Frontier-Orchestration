# Native application-check feasibility

This developer qualification kit exercises the production `CheckRunner` →
`darwin-seatbelt` revision 2 backend. It creates a fixture Git repository,
`Workspace` and `Journal`, and a local **draft** Codex-only coordinator goal for
production `ExecutionOwnership`. It never activates a goal, starts a worker,
requests inference, installs a database, or changes sandbox policy.

A completed kit can establish a capability gap. Its regression tests can pass
while its CLI exits **2** and reports **M001 BLOCKED**. Offline DOM behavior and
pure request/response logic do not prove a running networked application.

## Prepare existing inputs

Use the existing locked dependencies (`npm ci --offline --ignore-scripts
--no-bin-links` with an owned copy of the prepared cache). No downloads or
version upgrades are part of this kit. The source checkout needs `playwright`
and `playwright-core` 1.64.1 and the prepared browser cache at
`node_modules/.cache/ms-playwright`. The selected browser is
`chromium_headless_shell-1248`; its executable SHA256 is checked before use.
Package/cache inventories bind bytes, executable modes and internal links, and
are compared after copying to the fixture and protected workspace.

Supply these environment variables from the reviewed local input manifest:

- `MOSAIC_NATIVE_ARTIFACT_MANIFEST`: canonical absolute path to the existing
  `artifact-manifest.json` for the fork-only native Node and supervisor.
- `MOSAIC_NATIVE_ARTIFACT_SHA256`: exact approved manifest fingerprint.
- `MOSAIC_FEASIBILITY_TEST_PARENT`: existing canonical, user-owned directory
  with no group/world write permission, used only by the integration test.

Run the coordinator/CLI with the reviewed **official** Node, copied with its
license to an owned neutral directory. Keep the native artifact in its verified
location. Native checks use its exact pinned Node, independently of the CLI
runner. Machine-specific paths belong in local invocation records, not source.

## Run

The output parent must already exist. Choose a **new** child for each attempt:

```sh
node scripts/native-app-feasibility.mjs \
  --output "$NEW_OWNED_ROOT" --require-native --require-browser
node scripts/native-app-feasibility.mjs --inspect "$NEW_OWNED_ROOT"
```

`--inspect` verifies evidence hashes and emits the saved report. It performs no
execution, database startup, ownership reconciliation, Git action, or file write.
It parses the same report/index bytes it hashed and retains the saved exit class.
Inspect rejects evidence aliases, traversal,
missing report bindings, excessive bytes and changed evidence. The index binds
local evidence; it is not a signature against a party who can replace the entire
run directory. Retain the handoff's independent index hash for that purpose.

An explicitly supplied native manifest must be an existing canonical regular
file before output creation; an absent runtime configuration instead records a
missing prerequisite.

Execution refuses existing roots, noncanonical or symlink paths and Git override
environment variables before writes. `GIT_PAGER` is harmless and permitted;
other `GIT_*` variables must be cleared. Output directories are mode 0700 and
reports/evidence mode 0600. The tool records only selected inputs and bounded
command output, never the whole environment or credential files. Give it no
credentials. All TCP listeners bind `127.0.0.1` with ephemeral ports. Unix sockets
have unique owned paths; an excessively long socket path is inconclusive.

Both actual native and browser controls are requested by default. The
`--require-native`/`--require-browser` flags also record explicit invocation
intent. Missing required fixtures never turn into a passing capability.

## Observations and interpretation

| Capability | Actual observation |
| --- | --- |
| Pure handler | Exact health, invite success, validation and not-found responses without a listener. Changing the invite status deliberately must fail the unchanged protected assertions. |
| Offline browser | Pinned Chromium loads an explicit routed HTML/module allowlist, aborting unmatched requests and blocking service workers. Real checkbox/click/status assertions run. Changing selection logic deliberately must fail. No API listener is used. |
| TCP and Unix | Owned host server returns a unique token before and after each protected connection attempt. Only structured `EPERM`/`EACCES`, a successful check process and exact quiescence count as `denied`. Refusal, timeout, malformed evidence or unhealthy canaries remain `inconclusive`. A successful connection must match the token. Unix denial describes the boundary; it does not isolate filesystem from network policy. |
| PostgreSQL | Only existing required commands are inventoried from PATH or an explicitly supplied directory. Missing commands produce explicit not-run initdb/startup/migration/query states. No SQL parser, SQLite or mock database substitutes. |
| Networked API readiness | Healthy-host TCP denial blocks the future protected running API proof. Even a passing canary alone remains insufficient evidence of a protected listening API. |

The backend's own `verify()` additionally checks real fork-only child behavior,
filesystem enforcement and kernel process-group containment. Separate host-health
observations supply the stronger TCP/Unix evidence above. There is no injected
backend factory or mocked ownership callback.

The report distinguishes `passed`, `denied`, `failed`, `inconclusive` and
`not_run_missing_prerequisite`. CLI **0** requires every requested actual
capability to pass. CLI **2** covers blocked/unsupported/missing/inconclusive or
failed capability proofs. CLI **1** covers invalid input or tool malfunction.
Default networked application readiness is conservative: a canary cannot make
it ready without an actual protected listening API proof.

The baseline production policy denies networking. Do not weaken it to make this
kit pass. Carry a capability-gap proposal to coordinating review instead.

## Later existing PostgreSQL binaries

```sh
node scripts/native-app-feasibility.mjs \
  --output "$ANOTHER_NEW_ROOT" --require-native --require-browser \
  --postgres-bin-dir "$EXISTING_POSTGRES_BIN_DIR"
```

The supplied directory must exist, be canonical and contain actual executable
`initdb`, `pg_ctl`, `psql`, `postgres`, and `pg_config`. Missing commands are reported,
not installed. PATH-only detection never authorizes cluster creation; that needs
the explicit directory option. Host `--version` results are prerequisite
inventory only.

When all are explicitly supplied, the actual pinned protected Node attempts an
owned disposable cluster under `.overnight-output/pg-data`. It uses `initdb`, a
foreground `postgres` child, and `psql -X` for a real table migration and exact
query-result assertion. It uses its own trust/user/database fixture, empty Unix
socket setting and ephemeral TCP port, with no personal configuration changes.
The normal native policy can deny external executable/library/data access even
before networking. Record that result without adding grants or running a host
migration. A random per-run database role and an exact `data_directory` identity check
against the owned cluster are required before any migration; a responding server
on a reused port cannot authorize writes. The supervisor owns all descendants,
including failed startup, and
quiescence is still required. This optional path needs qualification on a host
with real PostgreSQL; no such success is implied by missing-prerequisite tests.

## Tests and retained evidence

```sh
MOSAIC_REQUIRE_NATIVE=1 MOSAIC_REQUIRE_BROWSER=1 \
  node --test --test-concurrency=1 test/native-app-feasibility.test.mjs
```

Required mode fails rather than skips if the actual host/runtime/browser inputs
are unavailable. Without the flags, deterministic tests run and the explicit
native/browser integration branch is marked skipped. A separately labeled
scripted lifecycle regression checks wrong-cluster refusal; it supplies no actual
PostgreSQL capability proof. Required tests retain their
run directory and print its path. Use a neutral output parent for native work.

Each run retains readable `REPORT.md`, bounded `report.json`, an
`evidence-index.json`, before/after source byte/mode inventories, selected
runtime/dependency identities, actual command/results, raw bounded observations,
production execution-owner records and exact supervisor completion receipts.
The live fixture/journal/coordinator state remains under that same root. Inspect
verifies the sealed exported evidence; retained working state is diagnostic and
is not silently accepted as sealed evidence.

After-attempt host health is saved even when a connection execution throws;
unknown executions propagate without launching further checks. Tooling failures
retain exit 1 rather than masquerading as blocked capability observations.
Unknown executions retain their owner and directory. The tool never force-cleans
an uncertain owner, removes an earlier run or modifies a shared runtime. Failed
attempts are evidence, not cleanup targets. No complete package/release suite,
public installation, provider pilot or M002 implementation is part of this kit.
