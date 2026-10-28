---
name: frontier-harness
description: Use when coordinating an approved goal across Codex and DeepSeek, selecting an execution mode, managing delegated assignments and questions, or inspecting harness evidence and managed learning.
---

# Frontier Harness

Use the installed harness MCP tools, or `node scripts/harness.mjs` with the private
`local-config.json`. Read [operations.md](references/operations.md) for connection,
CLI examples, schemas and recovery. Loading this skill does not dispatch work.

Prepare a goal with the outcome, acceptance, mode, repository/base revision,
read/write paths, literal trusted checks, public-source scope and limits. Show its
normalized manifest and exact approval hash. Activate within existing explicit
authorization; ask only when the concrete envelope still lacks authorization.
Fixture and live approvals are separate. Reuse submission IDs and mutation keys.

The default **collaborative** mode makes main Codex the supervisor and a working
partner. Queue independent assignments for DeepSeek, work concurrently through
native tasks, answer within-scope questions, and inspect saved evidence. Coding
and consult candidates await main Codex review. Research collection establishes
provenance; review selected reports when requested. A fresh native reviewer is
optional: reserve its run first, give it read-only evidence, and retain acceptance
authority. Use existing native agent tools only when available.

**DeepSeek only:** let its bounded planner and worker execute; no Codex execution,
review or answer fallback. Relay unresolved questions to the user. **Codex only:**
perform the work through native tasks; deterministic research tools remain
available and no DeepSeek requests are permitted. **Overnight review:** preserve
the check-gated, bounded background reviewer. Additional presets must use registered
capabilities; new executable adapters require reviewed code.

Use `native_start` for a separate Codex checkout. For takeover, request worker stop
and verify actual quiescence before `task_takeover`; edit only the returned native
checkout. Review actual diffs/checks, request focused same-task revisions, then
integrate accepted code and inspect combined checks. Long actions return operation
IDs; inspect `operation_get` rather than repeating the action with a new key.

Use priorities with reasons; dependency urgency is inherited. Urgent work yields at
a saved boundary. Pause/resume preserves IDs, deadlines and spending. An uncertain
request stays spent and holds ownership; inspect/reconcile it instead of creating
a replacement job or resetting counters. Waits are capped at30 seconds; do useful
independent work while delegated work runs. Notify on useful results, blockers,
required decisions and completion, rather than unchanged status.

Learning captures outcomes automatically. Budget at most one background learning
assignment within the goal's ten-assignment limit. Inspect protected evaluations,
applicability and sample counts; reflection alone proves nothing. Managed lessons
cannot modify permissions, checks, authored skills, credentials or core code.

Finalize only after the approved acceptance criteria are demonstrated. Deliver
the isolated branch, evidence and hashed receipt, or explicitly partial results
and exact blockers. Harness controls and native Codex goal controls have separate
lifecycles; closing the conversation does not keep native Codex working by itself.
