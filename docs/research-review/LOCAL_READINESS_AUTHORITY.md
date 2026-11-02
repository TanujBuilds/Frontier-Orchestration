# Read-only local acceptance for release advice

`readResearchAuthority({stateRoot, taskId, receipt, policy, reportBytes,
sourceBytes})` in `src/harness/release-authority.mjs` performs a fresh bounded
SQLite snapshot without constructing Store or Coordinator. It returns either
`{status:'pending', reason, runtimeAttested:false}` for unavailable/incomplete
local approval, or a verified version1 proof with goal/task IDs and hashes,
selected environment, accepted ticket/reviewer IDs and report/source/candidate
hashes. Invalid supplied records throw `ReleaseAuthorityError` with a bounded
redacted code. It never returns rows, review prose, private configuration or state
paths. It does not open database-provided artifact paths.

It reuses `verifyLocalAcceptance`, `verifyReviewedReceipt` and
`verifyAcceptedArtifacts`; no exported passed flag replaces those checks. The
state directory is an explicit trusted operator input, not an untrusted receipt
locator or cryptographic identity mechanism. Schema1 is supported; rows exceeding
1MiB fail before JSON decode. A read transaction covers schema and all three
selected records, including uncheckpointed WAL commits, with a1000ms busy timeout.
Connections roll back and close on success and validation failure. A killed reader
releases locks through normal process cleanup; it has no SQL write authority.

The source checker exposes paired `coordinatorStateRoot`/`coordinatorTaskId`
options and equivalent `--coordinator-state-root`/`--coordinator-task-id` flags.
The pair is policy3-only and must accompany enough exact evidence to validate
local acceptance. All explicitly supplied authority and artifact inputs are
validated even when a declared gate or assessment is failed/pending. Failure
remains failure and fixture evidence cannot grant live acceptance. Preparation
protects trusted state, evidence and candidate paths in both overlap directions.

Approval of local artifact bytes is separate from execution provenance. Existing
records do not retrospectively attest an executable version. A matching snapshot
can remove only the missing-local-authority blocker after independent live quality
and candidate binding succeed. Advisory output never grants installation or full
release authority; reruns must read current trusted state again.
