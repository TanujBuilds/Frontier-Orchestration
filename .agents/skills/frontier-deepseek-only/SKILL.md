---
name: frontier-deepseek-only
description: Use when a Frontier Harness goal explicitly requires DeepSeek-only planning and execution, local checks and integration, or inspection and recovery without Codex execution, review, takeover, or fallback.
---

# DeepSeek only

Use the same installed `frontier-harness` MCP service and read shared
[operations](../frontier-harness/references/operations.md). Prepare and activate the
exact authorized mode `deepseek_only`; preserve original scope, limits, IDs and
spending. Native chat may relay controls and actual user decisions only.

Leave bounded planning, implementation, checks and integration to the configured
DeepSeek worker. An empty active goal can use the bounded DeepSeek planner;
manually submitted narrower tasks must use permitted DeepSeek actors. Inspect
`registry_list` and tool schemas first. Do not pass forged native role/model
fields or switch modes to bypass a rejected action.

This mode forbids native coding/text/research/learning execution, native reviewer
reservations, Codex reviews, takeover and supervisor-answer/helper fallback.
Do not substitute main Codex implementation, Codex web research, automatic Codex
CLI calls or another provider when local execution fails. Stop and report the
actual blocker, preserving evidence and remaining budgets.

Use `questions_list` for unresolved saved questions. Relay the exact decision to
the user; after an actual answer, call `question_answer` with `responder:"user"`.
Never label a Codex-authored answer as a user answer. Scope expansion requires an
exact authorized goal revision after quiescence. A question, interruption or
revision does not reset deadlines, counters or request reservations.

Inspect state with bounded waits while the service operates. One harness-managed
DeepSeek assignment executes globally; external historical clients remain best
effort coordination. `work_control` stop is cooperative: verify actual quiescence
before recovery or partial finalization. No new task replaces uncertain execution.
Finalize only when approved acceptance and checks/integration are evidenced;
report fixture/live status and unresolved results honestly.
