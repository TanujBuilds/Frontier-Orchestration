# Codex + DeepSeek execution package

Approved 2026-10-29. Start from harness `714ed31a61a289503b63522d480c0790c0dc23c4`.

Codex remains the conversation and control interface. One durable MCP-backed coordinator manages scoped work; the dashboard observes Codex/DeepSeek assignments, evidence and handoffs.

Read [CONTEXT.md](CONTEXT.md), then only the assigned stage. Copy prompts from [GOAL_PROMPTS.md](GOAL_PROMPTS.md). A document is a specification, not passing acceptance evidence.

| Stage | Assignment | Depends on | Status |
|---|---|---|---|
| 01 | [Contracts and baseline](01-contracts-and-baseline.md) | none | passed; [receipt](receipts/01-contracts-and-baseline.json) |
| 02 | [Native collaboration](02-native-collaboration.md) | 01 | reviewed and integrated; real collaboration evidence recorded |
| 03 | [DeepSeek execution](03-deepseek-execution.md) | 01 | reviewed and integrated; real collaboration evidence recorded |
| 04 | [Skills and MCP package](04-skills-and-mcp-package.md) | 02, 03 | reviewed package; fresh-host discovery pending |
| 05 | [Observer API](05-observer-api.md) | 02, 03 | reviewed and integrated; viewer mutation-denial checks pass |
| 06 | [Observer dashboard](06-observer-dashboard.md) | 05 | approved layout reviewed; browser checks and real timeline capture recorded |
| 07 | [Installed validation](07-installed-validation.md) | 04, 06 | real pilots recorded; learning reuse and installed-host gates pending |
| 08 | [Research and release](08-research-and-release.md) | 07 for promotion | search/reader gates pass; two report pilots exhausted PARTIAL; [evidence](receipts/08-research-progress.json) |

Order: `01 → (02 ∥ 03) → (04 ∥ 05 → 06) → 07 → 08`.

Use isolated `codex/collaboration-*` branches/worktrees. One integration owner reviews/cherry-picks commits; never have agents share a writable checkout. Preserve the existing harness, unfinished lab and historical evidence. Put durable stage receipts in `receipts/`; private raw artifacts belong in ignored local evidence. Receipt template and completion rules are in CONTEXT.

**Current release: incomplete.** No stage is passed merely because its documentation exists. Final personal activation follows all mandatory gates; a disposable installed candidate is allowed for validation. No primary-branch merge, push or public publication.

Latest checkpoint: [new-chat handoff](NEXT_CHAT.md) and [structured budget fix receipt](receipts/09-budget-limit-fix.json). Fresh combined verification at `4c15023`: 323 Node tests, 98 Python tests and observer browser checks pass. These checks do not waive remaining live gates.
