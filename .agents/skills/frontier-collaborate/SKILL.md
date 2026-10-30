---
name: frontier-collaborate
description: Use when a Frontier Harness goal needs main Codex or native implementation agents working alongside delegated DeepSeek tasks, supervised questions, focused revisions, or candidate integration.
---

# Collaborative work

Use the same installed `frontier-harness` MCP service. Read shared
[operations](../frontier-harness/references/operations.md), then
[collaboration](../frontier-harness/references/collaboration.md). Prepare/activate
an exactly authorized `collaborative` goal; never migrate existing legacy records.

Main Codex is a working partner and operator: split independent work into bounded
assignments, delegate DeepSeek candidates, implement useful native work, and
review actual evidence before integration. Native concurrency follows available
host capacity and approved goal limits; the two optional reviewer runs are a
separate budget, not a two-implementation-agent cap. One harness-managed DeepSeek
assignment executes globally.

Discover `native_start` with `layout:"candidate_v1"`, `agent_register`,
`agent_report`, `agents_list` and `help_link` before parallel launch. Every native
writer uses only its own returned candidate checkout. Legacy omitted-layout
ownership cannot be assumed isolated. Finish returns a reviewable candidate;
main review/integration is separate. Do not dispatch a writer on a pending or
failed start operation.

Read [native roles](../frontier-harness/references/native-roles.md) before spawning
or changing a native model. Roles inherit host permissions; read-only reviewer
prose is a cooperative restriction, not a sandbox. Use only available host models
and verified private allowlists. Unsupported explicit choice fails clearly.

Answer saved DeepSeek questions within scope or link a bounded ordinary helper;
accept its evidence before answering the original question. Keep the same parent
IDs, counters and deadlines. Main review, answers and integration need an active
chat. While DeepSeek runs, do independent work or bounded event waits; closing the
chat installs no Codex supervisor. Takeover requires actual verified quiescence.
Never turn uncertain execution into a replacement task or reset its spending.
