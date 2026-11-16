# Three-worker routing rehearsal

This developer-only CLI uses three separately listening, ephemeral loopback HTTP
servers and scripted model responses and host assessments. Git, SQLite, coding
workspaces, native protected checks, review bindings and supported integration are
real. It does not contact a model service or coding app. It does not qualify live
model quality, the multiple-worker wizard (M027), real project delegation (M063)
or efficiency (M064).

## Run

Use Node 24 and the repository's locked dependencies. On macOS arm64 supply an
already qualified native revision-2 artifact; the CLI never builds or downloads a
runtime. Its manifest and file hashes, modes, platform and implementation must
pass the production validator. Use a canonical, existing parent directory and a
new task-owned child root. Paths through symlinks are refused.

```sh
export MOSAIC_THREE_WORKER_NATIVE_MANIFEST=/absolute/qualified-artifact/artifact-manifest.json
export MOSAIC_THREE_WORKER_NATIVE_SHA256=EXACT_VERIFIED_MANIFEST_SHA256
node scripts/demo-three-worker-rehearsal.mjs --root /absolute/owned-parent/new-run
node scripts/demo-three-worker-rehearsal.mjs --root /absolute/owned-parent/new-run --inspect
node --test --test-concurrency=1 test/mosaic-three-worker-rehearsal.test.mjs
```

Existing roots and Git repository override variables are refused before fixture
writes. `--inspect` reads the bounded saved report, without opening SQLite,
acquiring a lease, starting a listener or requiring the native runtime. A report
is historical fixture evidence, not a current health or live-readiness probe.

## What runs

The main scenario routes backend, frontend and tests categories to distinct
endpoint authorities. Every coding task owns one separate source file. The
backend canonicalizes an invitation address, the frontend formats its label, and
the third contribution expands adversarial specimens consumed by the immutable
protected reference check. The two implementation changes preserve behavior;
the third extends exercised input coverage. Workers cannot edit the checker or
its reference function. A deliberately incorrect uppercase backend fails the
same protected check and is repaired on its original worker.

All three actual Worker HTTP POST handlers must enter before an owned response
barrier releases any response. This proves inference overlap without timestamp
inference. Service/goal limits are three; each physical group/profile limit is
one. Protected-check ownership and repository serialization remain in force;
the report makes no check-throughput claim. Three passing candidates receive
scripted exact-bound host assessments via review reserve/submit and integrate
serially into one shared target through `task_integrate`. Combined checks run
again on that target, with the original repository unchanged. Restart and public
command replay preserve bindings, accounting and single review/import events.

Fresh scenario roots separately exercise:

- A held third worker: independent work progresses; a queued request on the busy
  route spends zero before admission, then resumes on that same worker.
- An offline third worker: readiness failure spends zero and allows independent
  work. Once readiness recovers, a real dispatched POST disconnects. That request
  spends one and its remote outcome remains unknown after restart.
- A same-endpoint alias: while the original request is held, an alias shares the
  physical group limit and cannot send another POST. A supported stop is
  requested before the original disconnect. Restart and public submission replay
  keep the original unknown outcome, spend and binding; alias spend stays zero.
  An uncertain lane refuses a later stop until reconciliation. No hold is cleared.

Fixture clock advancement crosses the production readiness cooldown; response
ordering uses explicit barriers, never sleep races. Bounds are one fixture hour,
eight tasks per scenario, two coding attempts/model calls and one assessment per
task. These fixed-response bounds are not real-model spending or performance
measurements. The rehearsal retains failed checks and all uncertain state.

## Evidence and recovery

`rehearsal-result.json` contains source HEAD/tree and tool-byte identities, exact
native runtime/fingerprint, endpoint profiles without credentials, selected
provider/revision/policy bindings, request IDs/outcomes, configured and observed
limits, combined check evidence and retained roots. Each scenario also writes
bounded `observations.json`; the main root retains per-task evidence. Native
execution-owner records remain in its SQLite state and artifact directories.
On failure, `failure.json` retains a diagnostic and the root is never reused.
Dummy auth is checked at the HTTP boundary but never saved in logs or reports.

All owned local workers and listeners close before a successful result is saved.
Remote unknown-outcome reservations remain held even after local shutdown. Keep
those roots for reconciliation; this tool has no cleanup/reset command. Do not
remove ownership records, release unknown holds or modify request rows to make a
rerun pass. Run again only in a new owned root.

The earlier [two-worker demo](../scripts/demo-routing-composition.mjs) proves a
sequential dependent repair/refactor. This rehearsal adds three independent
coding endpoints, barrier-proven overlap, one combined three-contribution target,
and separate real busy/offline/alias/disconnect paths. It reuses production
Coordinator, Dispatcher, Worker, provider registry, CheckRunner, scheduling and
integration. It does not call the legacy stage-14 evidence writer or duplicate
routing/scheduling rules.
