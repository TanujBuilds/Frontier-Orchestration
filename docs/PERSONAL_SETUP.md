# Personal setup and first use — proposed, unactivated

As of this 2026-11-01 preparation, the owner has approved conditional personal
activation after reviewed gates, with physical-phone testing allowed to remain
pending. This document and offline fixtures do not show those gates passed or
prove personal components installed. The supervisor must retain exact final
candidate, semantic-review, activation and installed-host receipts separately.
Full release remains incomplete while any required acceptance is pending. No
ordinary ChatGPT-wide mode or closed-chat wakeup is claimed.

## Prepare a reviewable installation

On the Mac, use the [offline checker](release-readiness/README.md) from the isolated reviewed source. Verify the candidate against **both independently retained hashes**, export applicable saved receipts into a new private directory, and run `--prepare` into a new disposable directory. Exit3 is expected with pending quality/installation gates. Read its JSON report and `staging-receipt.json`; compare file hashes. The bundle contains a proposed plist, literal MCP argv, four-sibling skill plan, secret-free config templates and watcher/phone/rollback checklists. Nothing is installed. Do not execute placeholders or bootstrap the proposed plist.

After the exact remaining pre-promotion gates pass, the supervisor may use the existing conditional owner approval and the [bounded checkpoint protocol](release-readiness/INSTALLATION.md), together with the existing [installation/rollback reference](superpowers/plans/2026-10-29-codex-deepseek/proposals/11-engineering/INSTALL_ROLLBACK.md). Select one immutable version, one private state root and one coordinator. Inspect and preserve existing host skill/MCP/service bindings before any change. Node24 and exact locked MCP SDK1.32.2 are required; the Python research environment must be independently pinned/verified. The package has four sibling skills under `VERSION/skills/` and one `VERSION/runtime/`. The primary entry is `VERSION/scripts/harness.mjs`. Keep private data/config outside the immutable package with owner-only permissions.

The private launcher binding is exactly `{"dataDir":"/ABS/PRIVATE/STATE","runtimeRoot":"/ABS/VERSION/runtime"}`. Select it with `FRONTIER_HARNESS_CONFIG`; do not overwrite adjacent legacy `local-config.json`. The provider configuration separately selects the existing approved model endpoint/model ID, research bridge and native host settings. Retain the current keys; never copy cloud auth into a package. Secret values belong only in private files and must not appear in shell history, screenshots or returned evidence. The rehearsal never reads private configuration.

## Discover the actual host

After gated supervisor activation, resolve the real primary launcher path and private state. The following Mac terminal commands are source-checked CLI shapes, **UNEXECUTED examples**:

```sh
"$NODE" "$VERSION/scripts/harness.mjs" --help
"$NODE" "$VERSION/scripts/harness.mjs" status --root "$STATE"
"$NODE" "$VERSION/scripts/harness.mjs" call --root "$STATE" --tool tools_list
"$NODE" "$VERSION/scripts/harness.mjs" call --root "$STATE" --tool registry_list
```

`NODE`, `VERSION` and `STATE` are explicit future absolute bindings, not guessed installed paths. `status` invokes the local authenticated service if available; it is not an offline checker. MCP discovery must also happen in an **actual fresh Codex host**. Do not restart the active owner app to force refresh; use one of the separately authorized fresh CLI test sessions and record desktop refresh as unverified if unavailable. Discover the `frontier-harness` stdio dependency by name/description, then inspect MCP tools/list (or exposed tools_list). Required current contracts include agent_register, agent_report, agents_list, help_link and native_start with layout=candidate_v1. Four focused skills share that dependency: frontier-harness, frontier-collaborate, frontier-deepseek-only and frontier-codex-only. If a required contract is absent, stop affected work and resolve the version; registration/configuration alone does not prove host invocation. Prior disposable CLI discovery does not prove hot refresh of this desktop conversation.

## First small collaborative assignment

After installation/host gates pass, use the single approved installed CSV pilot
in a NEW disposable clean committed repository. Its exact task is to export
`parseCsvRow(input)` in `src/parse-csv.mjs`: one record, comma delimiters, quoted
commas/doubled quotes, preserved unquoted whitespace/empty fields; empty input
returns one empty field. Reject any newline, unterminated quote, quote within an
unquoted field and trailing text after a closing quote. Built-in JS only; no file,
network or dependency side effects. Main prepares/protects the checks before any
worker output, binds exact base/read-write scope/manifest hashes and retains all
failed attempts. The worker writes only that source file and cannot change checks.

The approved limits are one assignment, three attempts, six DeepSeek requests,
two main review decisions, zero planner/automatic-review/questions and at most
1800 seconds capped by the parent deadline. Main uses the discovered goal_prepare
and goal_activate schemas with the already approved exact scope; preparation is
not activation. Do not execute a generic example manifest. A quality-gate failure
stops installation and this pilot. A failed pilot stays retained: no replacement,
extra requests or main-written rescue.

Submit one narrower DeepSeek coding task with stable submissionId/idempotencyKey. Use candidate_v1 for separately owned native work; do not edit the worker candidate. Review queue_get, task_get and bounded task_evidence/artifacts_list. Main Codex reviews actual diff and protected checks, records task_review accept/revise with focused feedback, and serializes checked task_integrate. Never infer acceptance from a model's completion string. Failed integration retains its pending owner; inspect discovered task_integration_repair rather than resetting the target. Finalize only accepted/quiescent work and return exact IDs, hashes, checks and remaining limits.

For questions, inspect questions_list. In collaborative mode main Codex can answer in scope with question_answer; user decisions must come from the owner. A helper consumes an ordinary bounded assignment and uses help_link; avoid automatic helper swarms. Revisions that change scope use goal_revision_prepare, show the new hash, goal_revision_activate after quiescence and explicit task_rebind. Revisions never refund spending, enlarge already started task limits or refresh deadlines. Follow-ups queue unless an explicit in-scope steering action is selected. For takeover, first verify actual worker quiescence; discover task_takeover/native_start, request candidate_v1, and use the **returned** checkout. Unknown remote execution retains ownership. Never clear leases or resubmit an exhausted job to create more budget.

## Observe and troubleshoot

The coordinator's loopback `/observer` dashboard is read-only; obtain access through the installed viewer binding. The viewer key is distinct from the operator key. Do not put either key in a URL or evidence. Main Codex decisions remain in Codex. The phone observer cannot approve, steer, stop or execute. Physical private-phone HTTPS/origin/cookie checks require separate activation/testing; a browser fixture or local screenshot does not pass them.

| Symptom | Safe next action |
| --- | --- |
| Key rejected | Confirm operator vs viewer role and the exact unchanged private state root. Read local status without displaying connection secrets. Do not regenerate keys or copy another service's key. |
| Wrong service/version or missing tools | Compare immutable package pins, service entry and discovered schemas; refresh actual host. Preserve existing bindings/state and stop affected work. |
| Auth expired | Use the provider/host's supported owner authentication flow when authorized. Do not copy auth files, weaken SSH checks or change providers. |
| Stale report | Check candidate/policy/report/source hashes and applicability. Preserve the original; create a separate reviewed export. |
| Pending reservation/ambiguous response | Inspect operation_get and task_get with original identities. Retry only the documented same-key operation, never a new ID to bypass spending. |
| Uncertain worker owner | Preserve lease/counters and inspect actual approved recovery controls. Mac process exit alone does not prove remote inference stopped. |
| Service unavailable | Compare selected root and configured binding with saved evidence; no model probe is needed for offline preparation. Reconnection and remote changes require separate scope. |

One harness-managed DeepSeek task executes globally. The two Sparks run one distributed model service. Other historical clients can still compete; global exclusivity beyond the harness needs explicit coordination. Mac coding/checks and the native Codex conversation require the Mac awake/available. An inactive chat does not guarantee reviews or wakeups. Detached Spark research can continue only after independently verified submission/deployment; the persistent watcher is a separate unpassed gate. Mac sleep can interrupt local coordination/collection even if remote work continues. Result availability does not promise native chat wakeup.

Captured worker activity and provider-reported tokens differ from host-reported native progress/usage. Missing native accounting stays unknown; do not call it zero or infer a price from aggregate tokens. Existing legacy overnight/task-queue/research records retain their original backend/IDs/approvals/counters/deadlines; see [compatibility](../.agents/skills/frontier-harness/references/compatibility.md). Do not migrate them by resubmission or select overnight mode to keep a closed collaborative chat reviewing.
