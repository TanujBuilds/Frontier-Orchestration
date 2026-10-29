# Operating the harness

The installed package contains a standalone runtime. Private `local-config.json`
sets `dataDir` and may set `runtimeRoot`; it is not included in portable packages.
Use the same state root and private provider config through restarts. Node24 is
required. The service runs on Mac loopback; DeepSeek is reached through its existing
HTTP API. SSH is unnecessary for Mac coding/inference. Spark research deployment
and collection use a separately configured backend and can have independent blockers.

```sh
node scripts/harness.mjs --help
node scripts/harness.mjs serve --config /absolute/private/provider-config.json
node scripts/harness.mjs call --tool tools_list
node scripts/harness.mjs call --tool goal_prepare --input /absolute/private/goal-input.json
node scripts/harness.mjs status
```

`--root /absolute/state-directory` overrides the configured data root. `serve` is
a persistent coordinator, not an inference server. Use the installed LaunchAgent
for restart supervision. `stop` stops this service after preserving ownership;
goal/task controls are separate and native Codex execution belongs to its host.
For local validation, create a private provider config containing
`{"environment":"fixture","fixtureReply":"Fixture answer"}` and start with an
explicit disposable `--root`. Fixture approvals must say `"environment":"fixture"`.
For live coding use `{"environment":"live","deepseekBaseUrl":"http://YOUR-EXISTING-SERVICE/v1","deepseekModelId":"YOUR-VERIFIED-MODEL","codexPath":"/absolute/path/to/codex"}`.
These are configuration examples, not verified endpoint or model values. Do not
commit the real provider file. Research additionally needs a private `research`
object with `python` and either `remoteConfig` or local `dataDir`/`providerConfig`.
The private connection file contains its loopback URL and bearer key. Do not print
the key or include it in reports, general lessons or tracked files.

Discover schemas through `tools_list`. Every mutation requires `idempotencyKey`.
A minimal prepare input is:

```json
{
  "idempotencyKey": "prepare-example",
  "manifest": {
    "submissionId": "example",
    "objective": "Compare durable queues for one AI worker",
    "acceptance": ["Cited primary evidence and explicit recovery tradeoffs"],
    "mode": "collaborative",
    "environment": "live",
    "limits": {"hours": 8, "maxTasks": 10}
  }
}
```

Coding additionally requires `project` with absolute `repo`, exact `baseCommit`,
`readPaths`, `writePaths` and `checks:[{id,argv,timeoutMs?,screenshots?}]`.
Directories end in `/`. Source must be clean and committed. Checks are literal
approved argv arrays; model responses cannot add commands or change protected
check/dependency files. Preparation itself neither approves nor executes.

`goal_activate` binds `{goalId,hash}`. `task_submit` takes `{goalId,task}`; each task
has a stable `submissionId`, `kind`, `objective`, `acceptance`, optional actor,
dependencies, priority, narrower permissions/scope and limits. Capabilities are
`coding`, `research`, `consult` and `learning`. Inspect mode restrictions before
submission. DeepSeek-only goals with no manually submitted work use the bounded
DeepSeek planner. A Codex-only task is ready for native execution, not a DeepSeek
queue item.

`task_get` shows counters/checkpoints; `task_evidence` returns bounded windows.
`artifacts_list` returns checksummed allowlisted report/screenshot references.
Artifact reads are authenticated, reject symlinks and changed checksums, and serve
source/report text as plain text. Page instructions remain untrusted data.
`questions_list` and `question_answer` use the saved assignment; an answer cannot
expand its envelope. `task_review` records accept/revise. Coding acceptance still
needs `task_integrate` and combined checks. Research/consult acceptance is not a
claim that independent factual certification occurred. Consults use one model
request by default, so a revision may exhaust their original request allowance.

`native_start` / `native_finish` manage native coding ownership.
After native editing has actually stopped, stop the assignment, then use
`native_release` with a reason to preserve an unfinished or expired checkout and
release ownership for a partial receipt. This retires that goal's coding checkout;
it does not discard files or integrate unaccepted changes. Stop other unfinished
tasks before partial finalization. Continuing coding needs a separately approved goal.
`native_text_start` / `native_text_finish` record native Codex consults without a
DeepSeek request. A takeover reason is required when the original actor differs.
`research_start` / `research_action` provide native search/read/finish, backed by
saved source IDs, passage checks and checksummed collection. Native research does
not run a DeepSeek self-check; its receipt says so. Research providers must match
the approved live/fixture environment.

`queue_get` separates execution and review. `task_priority` requires a reason.
`work_control` takes exactly one task/goal ID and pause/stop/resume. A requested
stop is not verified remote quiescence. Completed responses can replay after a
verified dead coordinator without new calls; pending/ambiguous inference remains
spent and blocks conflicting dispatch. Never delete the database/lease to recover.
For uncertain remote research use `research_reconcile`: the current coordinator
verifies the saved exact submission/hash, requests a remote yield, preserves
monotonic counters and requires verified quiescence before recovery. If contact or
identity is still uncertain, ownership stays held. Missing submissions are not
silently recreated. Collection failures marked `retryable` reuse the exact original
operation key; native research stores the remote action/finalization separately,
so a collection retry sends no second finish action. The dashboard shows these
operations and recovery controls. Integrity failures require investigation.

For changed scope, prepare and approve an exact goal revision after quiescence,
then explicitly rebind unfinished assignments. Rebinding preserves original task
limits and spending. Started assignments keep their objective and limits. A coding
permission correction additionally requires an approved new goal version and
explicit rebind; research-scope changes still require a versioned backend handoff.
Focused implementation corrections use same-task review feedback. Changed repositories or
bases after execution need separate explicit handling.

`learning_get` and `memory_retrieve` expose scoped evidence and pinned versions.
Reviewed evaluators support `edit_batch` and the narrowly applicable JavaScript
`backoff_zero` procedure. The latter requires a reviewed zero/overflow failure and
checked integration of its accepted correction. Their regression and two held-out
replays are labeled `protected_replay`, not broad
performance measurements. A budgeted learning task can propose/evaluate/promote;
quarantine and rollback affect future retrieval, not running assignments.
Native maintenance starts with `native_text_start`; its first proposal and one
repair are counted even if invalid. `learning_correct` creates a separately
evaluated candidate. `learning_archive` preserves evidence while removing a lesson
from future retrieval. Finish native maintenance after protected evaluation and a
recorded procedure decision.

`goal_finalize` produces a hashed immutable receipt only when work is accepted.
Explicit partial finalization requires stopped/quiescent unfinished work. Report
native Codex usage through host accounting; do not invent unavailable token totals.
Fixture receipts cannot satisfy required live deployment or pilot gates.
