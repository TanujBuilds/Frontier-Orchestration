# Stage 05 — Read-Only Observer API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose accurate bounded status, timeline, and saved evidence through server-enforced viewer authority without granting task execution control.

**Architecture:** Build read-only projections on existing coordinator records and durable event sequences. Keep operator MCP authority separate from viewer sessions, preserve loopback binding, and support an explicitly configured private Tailscale reverse proxy without trusting arbitrary forwarded headers.

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

- Viewer credentials must be denied every mutating operation server-side.
- Filtered cursors must progress without losing matching events.
- Artifact IDs must not become arbitrary path access.
- Forwarded headers must not weaken configured origin checks.
- Stale native reports must not imply live execution or quiescence.

## Current implementation and dependencies

Require accepted Stage02/03 receipts and their combined event/agent/candidate interfaces. Consume Stage01 activity/query validators. Can run alongside Stage04, but reconcile its final tool inventory before asserting viewer mutation denial.

Read `src/harness/api.mjs`, `artifacts.mjs`, `tools.mjs`, `store.mjs`, and dashboard data calls. The API currently accepts one operator bearer key or authenticated session, then lets `/api/invoke` dispatch any discovered tool. Hiding buttons would not make it a viewer. Existing Host/Origin validation requires the loopback URL exactly; private phone access must add an explicit configured external origin rather than disabling checks.

Existing protections include HttpOnly SameSite Strict sessions, same-origin login, CSRF checks for cookie mutations, no-store/no-referrer headers, restrictive CSP, constant-time hashed key comparison, bounded bodies, and allowlisted artifact IDs. Artifacts validates real paths, symlinks, size, and saved SHA256. Preserve these protections. `Artifacts.list()` currently registers artifact metadata, so consider this internal catalog maintenance separately from user execution mutation; it must not authorize arbitrary reads or modify task spending/state.

## Ownership and public interfaces

Own observer projection/API authorization code, private-origin configuration plumbing, artifact evidence windows, and `test/harness-api.test.mjs` plus new observer tests. Stage06 owns frontend assets. Prefer a focused `src/harness/observer.mjs` for read projections rather than expanding API routing into scheduler logic.

Expose `observer_snapshot`, `observer_timeline`, and `observer_evidence` as authenticated read tools, with equivalent viewer HTTP retrieval through the current invocation shape. Snapshot accepts optional goal/actor filters and returns summaries, registered agents, current tasks, queues, attention items, and accounting availability. Timeline uses Stage01 query `{goalId,actor,after,limit}`, default50/max200, and returns entries plus a durable next cursor. Evidence accepts an allowlisted artifact ID or task evidence reference with start/length capped32768 bytes, checksum/provenance metadata, and truncation indicators. Do not allow arbitrary filesystem paths.

The global cursor tracks the scanned durable sequence, including nonmatching filter entries, so filtered reconnect can progress. Tests must verify no duplicates, missed matching records, or endless scans when filters exclude every event. Events generated by the coordinator carry `coordinator` provenance; DeepSeek captured actions and native reported progress remain distinct.

Viewer sessions/credentials have explicit `viewer` role. Operator credentials retain existing rights. Authorize against a strict read-tool allowlist before calling Dispatcher, and deny unknown/new tools by default. `tools_list` exposed to viewers lists only allowed reads. Goal filtering is a presentation filter, not a security boundary: v1 is single-owner access to that service's state; do not invent unsupported per-goal ACLs. Evidence still requires membership in saved task/artifact records.

## Tasks and test-first sequence

### Task 1: Project truthful state

- [ ] Add RED snapshot tests for queued/running/question/review/paused/stopped/uncertain/partial/completed tasks and parallel native candidates.
- [ ] Registered native agents show last reported status/time, requested/resolved model when observed, and stale/missing reports explicitly. Do not infer hidden work from process counts.
- [ ] DeepSeek rows use actual captured action/request evidence. An active request with no chunks says running; it never implies supported token streaming or a completion percentage.
- [ ] Include known model usage separately from unavailable native-host accounting. Zero coordinator-dispatched Codex calls does not mean zero Codex cost.
- [ ] Build projection code and fixtures without changing scheduler authority or rewriting historical events. Older events lacking normalized fields remain visible as historical coordinator activity.

### Task 2: Cursor and bounded evidence

- [ ] Add RED tests for same-timestamp events, filter changes, reconnect after disconnect, empty pages with future matching data, invalid/negative/nonfinite cursors, limit201, and overlarge evidence windows.
- [ ] Implement deterministic chronological ordering and scan-cursor semantics. Filter changes reset the client query cursor rather than treating actor-specific offsets as global positions.
- [ ] Read bounded windows from allowlisted evidence and retain full protected request/check/result receipts separately. UI telemetry retention must not erase recovery/budget facts.
- [ ] Verify output labels and checksum metadata survive partial windows. UTF-8 output must not create invalid rendering or execute terminal escapes/HTML.
- [ ] Test traversal strings, absolute paths, artifact ID forgery, symlink replacement, changed checksum, and unrelated/private configuration file references.

### Task 3: Enforce viewer authority

- [ ] Add a table-driven RED test attempting every Dispatcher mutation as a viewer, including goal/task creation, question answers, review, native operations, learning mutation, acknowledgement, priority, stop, and service controls.
- [ ] Add same attempts via direct HTTP invocation and any alternate route. Return a consistent authorization failure before invocation; assert database/task/request counters remain unchanged.
- [ ] Implement separate private viewer credential creation/storage and session role. Never expose the operator key in viewer responses, browser storage, query strings, console logs, or artifact files.
- [ ] Preserve CSRF enforcement for operator cookies and role isolation on session refresh/relogin. A viewer cannot acquire operator rights by supplying a role field or reusing a CSRF value.
- [ ] Verify unauthenticated, expired, incorrect-key, cross-origin, invalid Host, duplicate-forwarded-header, and content-type/body-limit failures.

### Task 4: Private phone reverse proxy

- [ ] Add RED tests for explicitly configured HTTPS private origin versus arbitrary Host/Origin/Forwarded/X-Forwarded-* input.
- [ ] Permit only reviewed configured external origin/host combinations when reached through the expected loopback proxy path; never dynamically trust a browser-supplied forwarded origin.
- [ ] Keep Node bound127.0.0.1. Produce private Tailscale Serve deployment instructions; do not enable Funnel, public interfaces, or alter authentication policy.
- [ ] Retain application viewer authentication even on the tailnet. Protect cookies appropriately for HTTPS and same-origin navigation.
- [ ] Run `node --test test/harness-api.test.mjs test/harness-artifacts.test.mjs` and new observer tests, then `npm test` after changed code.

## Completion gate and handoff

The gate requires accurate real-data projections, bounded replay/evidence, and server-enforced denial of every mutation with no state effects. Include a race where a new mutator appears in discovery after authorization code was written: deny-by-default must still hold. Private proxy fixture tests do not prove a phone can reach the final service; actual private access is verified during installed validation/release.

Handoff supplies final observer schemas, cursor semantics, status/provenance labels, HTTP examples, authentication/expiry behavior, fixture IDs, and test logs. Stage06 consumes only these reads. Do not give it normal operator credentials as a shortcut. Record secrets in private runtime storage only; the receipt contains names/hashes, never values. Document v1's single-owner visibility and any native progress blind spots without claiming comprehensive host monitoring.

## Required handoff receipt

Use the shared receipt format in README.md. Include stage/objective; prerequisite and delivered commit SHAs; files/interfaces changed; exact test commands and exits; live versus fixture evidence; requests/usage where known; preserved IDs/deadlines/counters; artifact paths and SHA256 hashes; compatibility/rollback notes; limitations/blockers; and acceptance `passed` or `incomplete`. Do not mark this stage passed because this document exists. Keep private receipt details in local runtime artifacts and publish only sanitized summaries.

## Exact stage `/goal` prompt

> Complete Stage 05. Implement bounded read-only observer queries over actual coordinator events and saved evidence. Provide correlated actor/task/goal status, timeline cursor replay, attention items, and allowlisted expandable artifacts. Enforce viewer-only authority server-side and preserve existing operator protections. Support explicitly configured private Tailscale access without public hosting or binding the coordinator publicly. Test mutation denial, cross-origin access, cursor recovery, output injection, traversal, and stale activity. Do not add chat, approval, steering, or execution controls to observer access.
