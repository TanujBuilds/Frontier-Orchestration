---
name: frontier-harness
description: Use when preparing or selecting a Frontier Harness goal, inspecting its evidence, answering saved questions, managing controls, or choosing collaborative, DeepSeek-only, Codex-only, or bounded overnight work.
---

# Frontier Harness

One installed `frontier-harness` MCP service owns new unified goals. Loading a
skill does not dispatch work. Read [operations](references/operations.md) for
connection, exact preparation, state and recovery. Discover live tool schemas
before composing calls; fail clearly if the installed runtime lacks a required
contract. A skill or a model's text grants no executable authority.

Prepare the concrete outcome, acceptance, mode, repository/base, read/write paths,
trusted literal checks, public-source scope and limits. Show the normalized
manifest and exact hash; activate within existing explicit authorization. Ask
only for genuinely missing scope/authorization. Preserve fixture/live separation,
submission IDs, mutation keys, task IDs, deadlines, spent requests and failures.

| Requested workflow | Entry/reference |
| --- | --- |
| Main Codex and native agents working with DeepSeek | [Collaboration](../frontier-collaborate/SKILL.md) |
| Local-model execution without Codex fallback | [DeepSeek only](../frontier-deepseek-only/SKILL.md) |
| Native Codex execution without DeepSeek dispatch | [Codex only](../frontier-codex-only/SKILL.md) |
| Explicit bounded background review or historical jobs | [Compatibility](references/compatibility.md) |

Never silently switch modes. Main Codex supervises collaborative goals only while
its chat is active. MCP events do not create a new native turn. Use `events_wait`
with the saved cursor and at most30000ms; do independent useful work between
updates. Notify on results, blockers, decisions or completion, not unchanged state.
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
