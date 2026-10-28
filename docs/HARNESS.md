# Frontier Harness

Approved 2026-10-28. This opt-in workflow supersedes the review-only role split
only for harness goals. Legacy project and queue commands retain their policies.

## Outcome

Use the existing Codex conversation to select an execution mode, approve a goal
once, and coordinate bounded coding, research and consultation. The coordinator
owns authority, dependencies, budgets and evidence. Models do not grant authority.

Initial presets are collaborative (Codex leads and delegates), deepseek_only
(no Codex review/fallback), codex_only (no DeepSeek), and overnight_review
(legacy bounded review-only coding). Modes, capabilities and workflow templates
are versioned registries, not scheduler branches. New executable adapters need
reviewed code. Profiles compose existing primitives and cannot invent tools.

## Contract

A manifest binds objective, acceptance, mode, repository/base, read/write scopes,
trusted check argv, public research scope and limits. Activation requires the
exact normalized hash. Derived tasks are narrower and individually hashed.
Scope changes require approval; old counters and deadlines survive revisions.

Defaults: eight hours, ten delegated tasks, one active DeepSeek task globally;
coding five attempts/50 requests/two review decisions; research two hours,
30 searches/50 downloads/20 model calls; three clarification rounds; two optional
native Codex reviewer runs per collaborative goal, one at a time. Requests are
reserved before dispatch; ambiguous calls remain spent. Cached results replay.

SQLite WAL/FULL owns parent state; existing coding JSONL and research SQLite own
backend evidence. Stable IDs and recorded intents reconcile interrupted effects.
Single worker ownership is fenced; unknown remote execution retains its slot.

The execution queue and review inbox are separate. Questions save checkpoints,
release quiescent workers and await Codex (or the user in deepseek_only).
Revisions retain IDs and spending. Priority blocking/normal/background inherits
through dependencies, FIFO ties, no cycles. Urgent work yields only after a
bounded request/check and durable checkpoint. Manual pauses are not yield states.

Codex may work concurrently in a separate integration worktree. Takeover stops
and verifies the worker, freezes evidence and transfers permitted partial edits;
never manually edit the DeepSeek worktree. Integration is idempotent, checks
actual changed paths and reruns trusted checks. No automatic main merge/push.

Codex-only uses native Codex plus deterministic source tools. DeepSeek-only
plans in at most three requests, validates stages and integrates passing work
without Codex. Collaborative runtime never spawns a Codex CLI supervisor.
Overnight alone retains its legacy bounded CLI reviewer. Host Codex usage is
reported as unknown unless supplied; helper zero calls does not mean free chat.

## Learning

Capture outcomes, failures, corrections, checks, feedback, versions, requests,
time and reported usage. Distinguish observation, hypothesis and tested lesson.
Project memory is isolated; general lessons contain sanitized reusable procedures,
never private source, paths, endpoints or credentials. Uncertain scope stays local.
FTS retrieval is capped at four items/8 KiB and recorded by ID/version per task.

Only managed procedures automatically change. Recipes compose existing tools;
authored skills, core code, permissions, checks and model configuration are not
automatic learning targets. Core improvements are proposals. Promotion requires
the original regression plus two held-out cases and protected boundary tests,
with baseline comparison. Evaluation cases are not learner-writable. Pin procedure
versions at task start; future regressions quarantine versions. Every promotion
has hashes, evidence and rollback. Inspect/correct/disable/archive/rollback in UI.

One learning task per goal counts toward ten, low priority, max ten minutes
within goal deadline and six coordinator model requests including evaluation.
Native Codex gets one proposal and one repair under its host budget. Respect mode;
defer if no slot/budget; still record outcomes. No idle recurring learning loop.

## Surfaces and deployment

Node 24 SQLite coordinator, Mac LaunchAgent, local stdio MCP bridge and a skill.
Authenticated loopback API; Host/Origin/CSRF checks, escaped untrusted output,
allowlisted artifacts. Mutations have idempotency keys; waits max30 seconds.
Dashboard extends existing history with dark Carbon/Nunito styling, queue,
questions, review, budgets, evidence, learning and actual work controls.
Spark research persists without Mac; Mac work waits for Mac. Host /goal lifecycle
is distinct from coordinator work controls. No native app state manipulation.

## Acceptance

All old and new suites; duplicate commands and process death around reservations,
saving, finalization and integration; mode isolation, poisoning, scope, browser,
deadlines and single ownership. Register a fifth narrower preset without scheduler
edits. Independent branch review and installed skill forward-test.

Live: three collaborative assignments plus question/answer/review/revision;
urgent yield/resume; real partial takeover; DeepSeek-only complete coding;
Codex-only coding/research without DeepSeek; legacy compatibility; real failure
to evaluated lesson to fresh task successful reuse; disconnected-Mac Spark finish
and checksummed collection. Pending research gate: CPU-only pinned loopback
SearXNG, ten queries twice >=30 minutes apart, >=8 per pass with three relevant
domains and primary source, >=8/10 useful page reads; real report five primary
claims checked. External blockers keep release incomplete. Fixtures are not live.

No model training, unrestricted core self-upgrades, public hosting/publication,
unlimited recurring experimentation or additional workload skills in this build.
