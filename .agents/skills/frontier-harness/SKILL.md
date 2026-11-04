---
name: frontier-harness
description: Use Mosaic for a substantial new coding task that needs one of four working modes, or to continue, inspect, pause, stop, resume, answer questions about, or open the observer for Mosaic work.
---

# Mosaic

The personal coding-core release covers coding. Research remains parked; do not dispatch research or activate historical jobs. Keep the existing four mode IDs and one shared coordinator.

For a new substantial outcome, read [onboarding](references/onboarding.md) before
preparation. Use the explicit current choice, then the active goal's pinned mode,
then an explicitly owner-saved project preference. If still undecided, ask once:
“Which workflow: collaborative (recommended), DeepSeek-only, Codex-only, or
overnight review?” Wait for the choice. Quick questions need an ordinary answer.
Follow-ups keep their goal; a different explicit mode needs a supported transition
or separately authorized goal, preserving spending. Loading instructions and
choosing a mode authorize no dispatch.

One installed `frontier-harness` MCP service owns new unified goals. Loading a
skill does not dispatch work. Read [operations](references/operations.md) for
connection, exact preparation, state and recovery. Discover live tool schemas
before composing calls; fail clearly if the installed runtime lacks a required
contract. A skill or a model's text grants no executable authority.

Prepare the concrete outcome, acceptance, mode, repository/base, read/write paths,
trusted literal checks, public-source scope and limits. Present a short plain-English summary of the task, project, mode, intended changes, protected checks and numerical limits. Keep the normalized manifest, IDs and exact hash available as details; activate within matching existing explicit authorization. Ask
only for genuinely missing scope/authorization. Preserve fixture/live separation,
submission IDs, mutation keys, task IDs, deadlines, spent requests and failures.

| Requested workflow | Entry/reference |
| --- | --- |
| Main Codex and native agents working with DeepSeek | [Collaboration](../frontier-collaborate/SKILL.md) |
| Local-model execution without Codex fallback | [DeepSeek only](../frontier-deepseek-only/SKILL.md) |
| Native Codex execution without DeepSeek dispatch | [Codex only](../frontier-codex-only/SKILL.md) |
| Explicit bounded background review or historical jobs | [Compatibility](references/compatibility.md) |

Never silently switch modes. Main Codex supervises collaborative goals only while
its chat is active. MCP events do not create a new native turn. After a launch, use one deterministic `wait --root STATE --task ID` (or
`--operation ID`) invocation; see [operations](references/operations.md). Waiting
inside that process makes no model calls. A host process/session may be awaited
through its supported process tooling. Do not loop model turns over unchanged
MCP results. Notify on results, blockers, decisions or completion.
No always-on Codex supervisor is installed.

Inspect `goal_get`, `task_get`, `queue_get`, `questions_list`, `task_evidence` and
`artifacts_list` before changing uncertain work. Long mutations return an operation
ID: inspect `operation_get`; retry only a documented retryable operation using
its original key. A requested stop or agent report is not verified quiescence.
Never reset spending, delete ownership, or resubmit uncertain work to recover.

Read [learning](references/learning.md) only for scoped memory and protected lesson
maintenance. Finalize after demonstrated acceptance and integration checks; report
partial results and exact blockers otherwise. Host/native usage may be unavailable;
report unknown, never zero. Native `/goal` and backend goal lifecycles are separate;
do not create a native goal without an explicit request.

## Ordinary conversation

“Use Mosaic for this task” selects this entry. A substantial new coding task also qualifies for implicit invocation. An explicit mode skips the mode question; follow-ups keep their active goal. Do not make the owner copy tool arguments, internal records or terminal commands. Establish a committed Git baseline and isolate candidates; preserve dirty/unborn projects and explain the missing preparation without automatically committing the owner's files.

For “how is it going?”, inspect saved goal/task/queue state and summarize the result, current action, checks and any decision needed. For “pause”, “stop” or “continue”, resolve the intended current goal/task and use the existing work_control schema; inspect actual quiescence where required. Clarify only if multiple targets are plausible. Answer saved questions through questions_list/question_answer with the real responder and selected mode.

For “open Mosaic” or “show the observer”, resolve this installed primary skill's scripts/harness.mjs and the private launcher binding from the installed MCP configuration. Run its observer action with the same FRONTIER_HARNESS_CONFIG (or explicit verified --root). It opens the login-aware local home and copies only the viewer key locally. Never return credential bytes in chat. If login is requested, explain the one local paste. Opening the observer starts no task.

Use existing default limits as a proposal where the owner supplied none; disclose numerical limits before dispatch. A mode choice grants no missing permission. Use already matching task authorization without another confirmation ritual. Unavailable DeepSeek means report/defer according to the mode, never an undisclosed provider or mode change.
