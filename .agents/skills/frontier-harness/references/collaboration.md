# Native and DeepSeek candidates

Discover schemas from this installed server, not an old plan. `task_submit`
sets the assignment actor (`codex` or `deepseek`); supported task kinds and mode
come from `registry_list`. Use stable submission IDs for independent parser,
adapter and fixture tasks, disjoint write scopes and approved checks. Dependency
ordering uses saved task IDs. Main may implement substantial work in its own
native task; it does not edit another writer's checkout.

## Native execution and review

1. Submit an authorized Codex assignment. Confirm dependency/budget state. Choose
   a supported host model as described in [native roles](native-roles.md).
2. Call `native_start` with `taskId`, fresh stable mutation key and explicit
   `layout:"candidate_v1"`. Optional `registration` is version1, same taskId,
   actor `codex`, role `implementer` (or explorer), optional hostAgentId and
   `{requested,resolved}` model metadata. Omit unresolved metadata rather than
   invent it. Start registers before dispatch and returns `native.agentId`.
3. Observe its returned operation with the deterministic CLI `wait --root STATE
   --operation ID` described in [operations](operations.md). Recheck actual state
   after events; return when ready/attention rather than model-polling unchanged results.
   Give a host worker the actual absolute `result.native.worktree`, task ID,
   assigned files, checks, acceptance, deadline and shared role instructions.
   Dispatch writes only after successful reservation. If host correlation is
   known before start (a non-writing initialized worker), include it in start.
   Otherwise retain native.agentId and report the observed host correlation in
   the handoff; do not invent a new registration to replace existing ownership.
4. Parent reports actual progress with `agent_report`:
   `{idempotencyKey,version:1,agentId,status:"running",summary,evidenceIds:[]}`.
   Other statuses: waiting/completed/blocked/stopped. Reports are observations;
   neither a completion nor stop report releases ownership. `agents_list` shows
   only managed registrations, never all unrelated chats.
5. After host editing actually ends, `native_finish` with taskId/summary records
   checked candidate evidence in `awaiting_review`. Main inspects actual diff,
   approved check receipts and acceptance. In collaborative mode use `task_review`
   accept/revise; a focused revision retains task/base/spending and reopens with
   explicit candidate_v1. Do not create a new task to refresh attempts/reviews.
6. Accepted coding candidates require `task_integrate` and combined checks.
   Finish alone does not accept or integrate. Import conflict/failed combined
   checks retain pending ownership and failed evidence. Do not reset/edit the
   integration checkout. Discover `task_integration_repair` with taskId, reason
   and idempotencyKey; inspect its operation result. Its supervised inverse uses
   saved import preimages, never a blind Git rollback. Unexplained target changes
   or an unavailable contract remain blockers. Correct, re-review and integrate
   the same task within original limits, preserving failed-check evidence.

Multiple native writers can run in distinct candidate_v1 checkouts beside the
single DeepSeek worker; the integration target is serialized by the runtime.
Before dispatch, verify the exact task read scope also contains the dependencies
imported by its protected checks. A check script being approved does not make
unlisted source files appear in the scoped checkout. Establish a passing
baseline where appropriate and distinguish baseline failures from intended
feature failures. Do not spend repeated model attempts on missing check inputs.
Stop, preserve counters/evidence and prepare an approved versioned correction
when scope is wrong; never expand it from model output or refresh attempts.

No worker writes to the integration target, primary checkout or another candidate.
Overlapping changes may conflict and need a focused same-task correction.
Never convert an existing omitted-layout legacy task to candidate_v1 implicitly.

For takeover, request stop via `work_control`, verify host/worker quiescence, then
`task_takeover` with reason and explicit candidate_v1. For abandoned native work,
actually interrupt/join the host writer, stop the task and `native_release` with
host-confirmed reason. Preserve partial files/evidence. Unknown execution remains
owned; agent_report stopped is insufficient. Legacy release may retire the whole
integration checkout; inspect saved layout before assuming further work is safe.

## Saved questions and helpers

`questions_list` exposes the current saved question and task. Read task/envelope
before answering. Within authorized collaborative scope, `question_answer` uses
`responder:"codex"`; unresolved user decisions use actual `responder:"user"`
only after the user answers. Never invent a user response.

A helper is an ordinary narrower `task_submit` in the same goal with its own
stable submission ID and remaining assignment budget. Link it using
`help_link:{idempotencyKey,version:1,taskId:parentId,questionId,helperTaskId,reason}`.
Parent must have a live quiescent supervisor question. Helper must not depend on
its blocked parent; cycles fail. Helper consumes ordinary budgets. Complete,
review and accept helper evidence before answering the linked original question.
Answer preserves the parent's question/counters/deadline; inspect `task_get` and
`queue_get` for actual resumed state. A separate explicit pause is not inferred
cleared. If helper scope exceeds the approved envelope, prepare exact goal
revision instead. DeepSeek-only forbids this supervisor helper/answer fallback.

## Optional independent reviewer

`reviewer_reserve` takes taskId and reserves one of two reviewer runs per
collaborative goal. This count is separate from implementation capacity. Give a
fresh native reviewer read-only saved evidence and applicable acceptance, then
`reviewer_finish` records reservationId plus result or error. Main retains
acceptance/integration. Do not turn a reviewer into an implementer or invoke an
automatic Codex provider call. Host accounting unavailable stays unknown.
