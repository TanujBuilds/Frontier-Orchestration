# Stage 07 — Installed Candidate and Collaboration Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the combined package works from an actual native Codex host and independent installed runtime before final personal promotion.

**Architecture:** Install a disposable checksummed candidate with isolated state/configuration, drive it through public MCP interfaces, and correlate native-host evidence with backend receipts and observer results. Use genuine bounded model pilots and crash tests while preserving failed evidence.

**Tech Stack:** Node24, SQLite with WAL and synchronous=FULL, Git worktrees and journals, MCP SDK1.32.2, pinned Python research runtime, Playwright1.64.1 where applicable. Recheck versions before relying on them.

**Spec:** [Approved execution package](README.md) and [shared context](CONTEXT.md), based on the approved 2026-10-29 Codex + DeepSeek Collaboration Package. Starting source revision `714ed31a61a289503b63522d480c0790c0dc23c4`; later stages consume reviewed prerequisite receipt commits.

## Global constraints

- Codex remains the user interface; the dashboard is read-only. One MCP service owns dispatch.
- Four modes remain isolated: collaborative, DeepSeek-only, Codex-only, and bounded overnight review.
- One harness-managed DeepSeek task executes globally; native concurrency inherits host capacity and approved goal limits.
- Preserve exact approvals, stable identities, absolute deadlines, request spending, failed evidence, and ownership through restart, revision, and takeover.
- Do not change model runtime settings, authentication policy, credentials, trusted checks, or permissions through model output or automatic learning.
- Public tracked documentation contains no private endpoints, machine paths, credentials, or copied project source evidence.
- No push, primary-branch merge, public hosting, new provider, or experiment-lab expansion.

## Review Focus

- SDK success must not substitute for actual native-host discovery.
- Genuine partial takeover must preserve original worker evidence.
- Strict modes must prohibit fallback calls on failure.
- Crash recovery must preserve spending and avoid duplicate commits.
- Protected replay must not be presented as universal learning improvement.

## Current implementation and dependencies

Require accepted Stage04 and Stage06 receipts, together with the reviewed combined integration commit. Source-level unit tests and an SDK client are necessary but insufficient: the candidate must resolve runtime imports without the development checkout and be discoverable by the actual native host. A globally installed skill file does not prove an already running conversation has refreshed MCP tools.

Read `test/harness-{package,mcp,integration,crash,research,learning}.test.mjs`, package/CLI instructions, and each skill as an ordinary user would receive it. Earlier walkthrough evidence demonstrated accepted assignments and real DeepSeek calls, but it did not verify all new collaboration paths. Do not reuse it as proof of this stage.

## Ownership and verification interfaces

Own integration test/pilot scripts, candidate installation receipts, and focused fixes reported to owning agents. Avoid a large independent production rewrite during validation. If a defect requires contract changes, return it to the relevant stage and rerun dependent gates on the corrected candidate hash.

Use public tool discovery and invocation for normal workflows. Direct SQLite inspection is permitted to verify accounting/ownership, not to fabricate success transitions. Private temporary config holds model endpoint and native host registration; public receipts contain only sanitized version/outcome summaries and hashes.

Every pilot binds exact objective, acceptance, mode, repository base, allowed paths/checks/source scope, budgets, and deadline before activation. Native host usage is separate from coordinator-dispatched model requests; mark unavailable token totals rather than claiming zero cost. Live/fixture environments stay distinct.

## Tasks and test-first sequence

### Task 1: Install an isolated candidate

- [ ] Build a new immutable version directory and verify its complete hash manifest. Save package source commit and dirty flag; release candidates must be traceable to reviewed committed source.
- [ ] Start candidate service with separate state/config/ports. Do not replace the owner's final LaunchAgent or reuse an active development database.
- [ ] Connect the actual Codex host through supported MCP registration, then inspect discovered tools and invoke a harmless public read. Record whether host reload/restart was required.
- [ ] Prepare, approve, submit, inspect, and finalize a disposable fixture goal through actual native-host calls. Prove calls target the installed candidate by reported package hash/runtime identity.
- [ ] Independently forward-test skills from installed instructions only. Preserve unsupported-host details as blockers rather than substituting an SDK test and declaring success.

### Task 2: Collaborative live pilot

- [ ] Define a small real coding repository with protected trusted checks and independently useful source/test changes; keep its files out of public receipts if private.
- [ ] Register two native implementers and queue at least three DeepSeek assignments, allowing independent Codex work concurrently with the one DeepSeek execution slot.
- [ ] Obtain a genuine DeepSeek question and checkpoint. Main Codex answers within scope or accepts a substantial linked native helper task, consuming the same goal budget.
- [ ] Resume the original DeepSeek task with unchanged ID/counters/deadline. Save handoff evidence and prove helper edits were integrated before dependent work used them.
- [ ] Produce candidate review, one meaningful revision under the same task, and final checked integration. Record candidate/base/integration commits and combined checks.
- [ ] Observe actual tasks in the dashboard; verify reported native activity and captured DeepSeek evidence remain distinguishable.

### Task 3: Yield and genuine takeover

- [ ] Queue a blocking repair behind an active bounded request/check. Verify safe result/cursor save and quiescence before urgent dispatch, then resumption without budget refresh.
- [ ] Save genuine DeepSeek partial edits, stop/quiesce it, and take over into a separate native candidate. Freeze/hash the original worker snapshot and verify it remains unchanged.
- [ ] Interrupt around request reservation, result saving, candidate finishing, review, Git import/checkpoint, and final state recording. Use actual process SIGKILL tests where appropriate, not only thrown exceptions.
- [ ] Replay identical mutations and submissions after restart. Assert one identity, one intended effect, preserved queue ordering, approvals, counters, deadlines, and no duplicate commit/inference.
- [ ] An ambiguous remote request stays spent and owns the conflicting slot until reconciled with real evidence. Do not force-clear it just to continue the pilot.

### Task 4: Strict modes and legacy review

- [ ] Run DeepSeek-only bounded planning (at most three planning requests), coding, protected checks, and integration. Verify no Codex execution/review/answer fallback or automatic native call occurs.
- [ ] Run Codex-only native coding and deterministic public-source research. Inspect request records and assert zero DeepSeek dispatches, including planner/probe/error fallback.
- [ ] Exercise inherited native model selection and one supported explicit override. Unsupported explicit requests fail visibly.
- [ ] Run existing overnight-review compatibility through genuine check-gated review, preserving its bounded calls. An existing unchanged pilot may supply compatibility baseline only when version relevance is demonstrated; new changed paths need fresh evidence.
- [ ] Verify legacy coding JSONL and research SQLite records remain readable with unchanged IDs/limits and do not become newly queued tasks.

### Task 5: Bounded learning pilot and independent review

- [ ] Use a real supported failure/correction with checked acceptance to propose a project-local candidate lesson. Keep observed facts, hypotheses, and evaluated lessons separate.
- [ ] Run the protected regression plus two held-out evaluations; preserve permission/mode/budget/evidence checks and before/after comparison. Existing evaluator families are edit_batch and backoff_zero, not arbitrary executable skills.
- [ ] Promote only after evaluation, then start a fresh task that retrieves the pinned lesson and demonstrates the intended behavior. Running assignments retain their original version.
- [ ] Verify poisoning, cross-project leakage, stale applicability, duplicate promotion, quarantine/rollback, and exhausted learning budget. Do not exceed one learning assignment/ten minutes/six dispatched requests within the goal.
- [ ] Obtain independent code review of ownership, permission/mode enforcement, migration, transport, viewer access, and packaging. Resolve material findings with focused regression tests.

## Completion gate and handoff

Run `npm test`, pinned `python -m unittest discover -s test/research -p 'test_*.py'`, and `npm run test:observer`. Record exact commands/exits/test versions, not historical counts copied as expected results. Confirm suite-generated artifacts do not leak private config.

The gate requires installed native-host MCP calls, all four live modes, substantial collaboration/help, review/revision/integration, urgent resumption, genuine takeover, protected learning reuse, restart tests, browser results, and reviewed fixes. Mark each separately as live/fixture/incomplete. A failed external dependency leaves the corresponding gate incomplete; do not reset its budget to retry indefinitely.

Deliver candidate hash, prerequisite/source commits, task IDs/limits/spending, native model evidence, pilot artifacts/checksums, review findings/resolution, exact remaining blockers, and a promotion recommendation. Final personal installation belongs to Stage08 only after its Spark gates also pass.

## Required handoff receipt

Use the shared receipt format in README.md. Include stage/objective; prerequisite and delivered commit SHAs; files/interfaces changed; exact test commands and exits; live versus fixture evidence; requests/usage where known; preserved IDs/deadlines/counters; artifact paths and SHA256 hashes; compatibility/rollback notes; limitations/blockers; and acceptance `passed` or `incomplete`. Do not mark this stage passed because this document exists. Keep private receipt details in local runtime artifacts and publish only sanitized summaries.

## Exact stage `/goal` prompt

> Complete Stage 07 using a disposable installed candidate and separate state. Independently demonstrate native Codex plus DeepSeek collaboration, questions and helper work, review/revision/integration, priority yield/resume, genuine partial takeover, all four modes, and protected learning reuse. Verify actual Codex-host MCP discovery and calls, not only API health. Run Node, Python, browser, crash, ownership, mode-isolation, and package tests. Obtain independent review and resolve material findings. Preserve failed attempts and spending. Do not promote the final personal installation or substitute fixtures for required live evidence.
