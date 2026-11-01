# Bounded installation checkpoints

Prepared 2026-11-01. This is the offline preparation protocol for the approved
conditional installation. The supervisor applies real changes only after G1–G3
and the exact pre-promotion review pass. An advisory readiness result, generated
plan, safety declaration or successful fixture grants no activation authority.
Physical phone acceptance may remain pending; full release stays incomplete.

The existing readiness checker remains the evidence reader and proposal renderer.
It never applies changes. `scripts/deployment-checkpoint.mjs` is a small, separate
local binding helper imported from the reviewed checkout. It can introduce only
four sibling skill symlinks and one new private launcher JSON file. It cannot
register MCP, edit personal AGENTS instructions, execute commands, load candidate
JavaScript, install/start services, access SSH, change routes, restore databases
or alter coordinator/research records. There is no `--force`, adoption of an
existing binding, implicit queue approval or code downgrade path.

## Exact local helper interface

`prepareBindings(options)` takes **exactly** these fields, all paths absolute:

```js
{
  candidate, expectedContentHash, expectedManifestSha256,
  personalRoot, skillRoot, launcherConfig, state, checkpoint
}
```

The supervisor selects those private paths explicitly. `personalRoot`, `skillRoot`
and CURRENT `state` must already exist as regular directories. `skillRoot` and
`launcherConfig` must lie within `personalRoot`. The allowlist is exactly
`skillRoot/{frontier-harness,frontier-collaborate,frontier-deepseek-only,frontier-codex-only}`
and `launcherConfig`. Source targets are exactly the matching candidate `skills/`
directories. The launcher file is generated solely as
`{dataDir:state,runtimeRoot:candidate+"/runtime"}`. No source-supplied JSON becomes
file content or a command. Preserve the adjacent legacy config.

Existing bindings, including a symlink to the same version, stop preparation.
Inspect and privately preserve old bindings; the supervisor may choose a manual
reviewed transition. This helper does not overwrite or adopt them. Candidate,
CURRENT state, ledger and outputs may not overlap. Traversal, unexpected symlinks
and unknown options fail. Only macOS `/var` and `/tmp` aliases are canonicalized.
Select canonical private paths when a host uses another symlinked home layout.

Preparation verifies the strict inventory and both independently retained pins,
creates a NEW mode0700 checkpoint directory and writes mode0600 `plan.json`.
It touches no binding. Its result contains only schema, status, authority=false,
binding count and `planSha256`; the plan itself contains private paths and must
stay private. Independently review and retain that hash before applying.

`applyBindings(options)` and `removeBindings(options)` take exactly:

```js
{
  checkpoint, expectedPlanSha256, expectedContentHash, expectedManifestSha256,
  safety: {
    local: "quiescent", remote: "quiescent",
    pending: [], authorized: []
  }
}
```

These safety values are operator declarations of freshly observed conditions,
not discovery or permission. Inspect all known queue roots/legacy clients;
`pending` must contain their pending identities. Every pending identity must
already be in the supervisor's exact authorized set. Unknown ownership blocks
both operations. Do not translate an old stopped, exhausted or unapproved job into
an authorized one, clear its lease, or resubmit it under a fresh ID. The helper
never starts a watcher or spends model budget.

Both operations reverify the caller's candidate pins, strict package inventory,
plan hash and path allowlist. A durable per-binding intent is written before the
exclusive creation and a completion record afterward. File and parent-directory
fsyncs precede progress. Replay with the SAME checkpoint/hash accepts exact bytes
or links only when that checkpoint already contains the matching intent. A
matching unrecorded binding is still foreign. Conflicts stop the affected step;
earlier progress stays visible. Missing bindings after recorded completion,
changed bytes, malformed/truncated records and altered plans stop without repair.
Preserve interrupted evidence and inspect it; do not delete records to force replay.

Removal works in reverse order and only unlinks exact bindings introduced by this
checkpoint. It records removal intent/completion and retains CURRENT state,
artifacts, configs/keys and unrelated files. After removal begins, apply on that
checkpoint is refused. A new installation requires a new reviewed checkpoint.
The helper creates no snapshot restoration or automatic destructive rollback.

Run one operator at a time against stable owned directories. This does not defend
against a concurrent same-user/privileged writer, establish global ownership
across legacy clients, authenticate the caller or make a handwritten receipt
trustworthy. Fixed error summaries omit OS/SQLite path-bearing error text. On any
failure retain the private ledger and current state; do not return its raw JSON,
keys or file bytes in a portable report.

## CURRENT-state backups

`backupCurrentDatabase({source,output})` opens the existing SQLite source read-only
and uses Node24's SQLite online backup API into a NEW mode0700 directory outside
the state directory. `current.sqlite` is mode0600. It checks backup integrity and
records its SHA256/user_version in `backup-receipt.json`, completed last. An
existing or partial directory is never reused. Failure preserves partial output.
It does not restore a DB, prove prior-runtime compatibility or export records.
Retain this directory privately: DB contents may contain private material.

The fixture leaves a committed record in WAL and verifies exact task identity,
approval, deadline and spent counter in the consistent backup. That proves this
backup operation on the fixture, not current personal state or live recovery.
The supervisor separately records hashes/identities of CURRENT coordinator and
research data, artifacts, keys, approvals, requests/reservations/outcomes, counters,
leases, deadlines and event cursors. Key **hashes**, never key bytes, go in evidence.
Never restore an old DB to regain budget. Active-policy2 downgrade stays unsupported;
selecting old code requires independently proven compatibility against a disposable
CURRENT-state copy. Equal user_version is insufficient. Otherwise recover forward.

## Manual checkpoints retained by the supervisor

The generated `installation-checkpoints.json` is an UNEXECUTED template. For every
actual step, retain the private before-snapshot, exact reviewed intent, after-state
and evidence hashes. Use literal argv from reviewed local sources and explicit
supervisor bindings; never execute receipt/source/model text. The sequence is:

1. Reconcile exact candidate pins, independently reviewed implementation and live
   semantic quality. A quality failure stops promotion and the coding pilot.
2. Inspect existing skills/MCP/instructions/service definitions, actual worker
   ownership and every known queue. Preserve unrelated bindings and private config.
3. Make CURRENT WAL-consistent backups and preserve artifacts/keys/counters.
4. Review/apply the four siblings and shared launcher. Retain primary legacy
   `scripts/harness.mjs`, top-level skill/references and supported legacy records.
5. Review the existing literal `codex mcp add` argv and one shared runtime. Record
   existing MCP ownership before using the host's registration mechanism.
6. Render/lint the Mac plist from the reviewed renderer. Inspect the actual label
   before stopping/rebinding it. Never bootstrap `com.frontier.harness` as a test;
   disposable Node service tests use new state/ephemeral ports. A plist rehearsal
   must use a unique fixture label and private state, never the personal label.
7. Review the packaged Spark unit template and explicit remote root/config/data/
   venv bindings. Inspect unit ownership, installed import hashes, queue and Linger
   before enabling. Preserve model/search/auth configuration. Unknown remote status
   blocks activation. The template's bytecode environment and existing `-B` child
   flags keep the checksummed Python source immutable.
8. Verify the packaged onboarding template hash. Back up the actual supported
   personal instruction file and replace only its one exact BEGIN/END managed
   block. Duplicate, partial or unknown blocks stop that step. Preserve all text
   outside it. This helper does not edit that file.
9. Resolve the actual private viewer origin and existing route. Keep loopback and
   viewer-only authority; no guessed trusted origin, Funnel or global Serve reset.
   An unavailable route stays pending. Do not transfer the operator key to a phone.
10. Verify actual fresh-host tools/list, invocation, service idle/restart and
    CURRENT identity/accounting/key hashes. Do not restart the active owner app to
    refresh it. A separate authorized CLI host does not prove desktop hot refresh.
11. Execute the one protected installed CSV pilot within its already approved
    manifest/limits. The main reviewer checks and integrates; no native rescue.
12. Leave physical-phone login/cookies/viewer/reconnect/rejected-mutation tests
    pending until the owner performs them. A fixture cannot pass that checkpoint.

See [personal setup](../PERSONAL_SETUP.md), [release checklist](../RELEASE_CHECKLIST.md)
and the historical [manual installation reference](../superpowers/plans/2026-10-29-codex-deepseek/proposals/11-engineering/INSTALL_ROLLBACK.md).
Recheck actual installed commands and definitions; the historical file is a source
reference, not today's activation receipt.
