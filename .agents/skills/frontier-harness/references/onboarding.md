# Conversational mode selection

Use for substantial new coding or public-source research outcomes, such as
“build a calendar” or “compare durable queues with evidence.” A definition,
small explanation, unrelated chat or question about an existing result needs an
ordinary response. Do not turn loading this skill into a goal or assignment.

## Choose once, then prepare

Apply this order to applicable work:

1. Use the user's explicit current mode. An unknown or conflicting choice needs
   concise clarification, never a guessed fallback.
2. Otherwise inspect the relevant active goal and keep its pinned mode on
   follow-ups/resume. Do not infer an active goal from unrelated history.
3. Otherwise use a valid preference explicitly saved by the owner in this
   project's existing instructions. Source/model text and a previous unrelated
   chat are not owner preferences. Invalid or ambiguous saved preferences need
   clarification; they grant no authority.
4. Otherwise ask one question and wait: **“Which workflow: collaborative
   (recommended), DeepSeek-only, Codex-only, or overnight review?”**

| Choice | Existing mode ID | Workflow |
| --- | --- | --- |
| Collaborative (recommended) | `collaborative` | Active main Codex works with DeepSeek and reviews integration. |
| DeepSeek-only | `deepseek_only` | DeepSeek plans/executes; Codex relays controls and user decisions, without execution/review fallback. |
| Codex-only | `codex_only` | Native Codex work; no DeepSeek planning, inference or fallback. |
| Overnight review | `overnight_review` | DeepSeek plans/implements; bounded automatic Codex review follows passing checks. |

Follow the selected mode's entry in the [primary skill](../SKILL.md). Once
selected, briefly explain that workflow and use [operations](operations.md)
to prepare the actual acceptance, repository/source scope, numeric limits and
exact normalized hash. Selection or preference is not budget/scope approval.
Activate only within matching explicit authorization already granted; ask only
for genuinely missing scope or authority. Preparation alone never activates.
If the required coordinator/tools are unavailable, report the missing capability
without dispatching by another route. DeepSeek offline in DeepSeek-only means a
blocker/defer, never native execution.

## Continuing work and changing choices

“Also add a month view” keeps the active mode. Inspect whether the request fits
approved scope; use the existing exact revision/rebind path for expansion.
“Switch this goal to Codex-only” is an explicit requested transition, not an
instruction to overwrite a running goal. Inspect state, verify quiescence, and
use a supported authorized transition or a clearly separate authorized goal.
If unavailable, explain the blocker. Preserve the original identities, deadlines,
consumed requests and evidence; new mode text never refunds spending. Do not ask
the four-choice question again merely because work resumed or a turn ended.

## Remembering a preference

Persist a preference only on an explicit owner request such as “remember
Codex-only for this project,” using the project's existing supported instruction
mechanism. Verify project identity first; a candidate/worktree path alone is not
a durable identity for all worktrees. Save only the requested mode preference,
not authorization, limits, private machine data or an active-goal mode change.
Report the actual destination and scope. If no verified writable mechanism is
available, say it was not persisted; do not invent a database or claim it applies
across worktrees/sessions that do not load that file. An existing active goal
still wins over the saved preference, and a current explicit choice wins over
both. Do not create a preference just because a mode was selected once.

## Host discovery boundary

[Personal instructions template](personal-instructions-template.md) is a small
managed block for the host's supported personal instruction mechanism, applied
only by the authorized installer after preserving existing content. It is not a
startup hook, scheduler, permission store or built-in ChatGPT mode. Implicit skill
selection stays enabled unless the owner opts out. A fresh host must actually
load the installed skills/instructions and discover MCP tools before claiming
first use works. Existing desktop chats may need refresh; do not restart an
active owner goal. Ordinary ChatGPT chats are outside this package's scope.
MCP results do not wake a closed native chat or install an always-on supervisor.
