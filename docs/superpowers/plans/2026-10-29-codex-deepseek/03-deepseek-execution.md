# Stage 03 — DeepSeek Context, Actions, and Live Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair DeepSeek working context and expose captured execution activity without weakening bounded actions, request accounting, or recovery.

**Architecture:** Keep CodingAdapter and Worker as the execution path, adding bounded checkpointed working-set metadata and correlated evidence. Probe the unchanged service for streaming; publish visible chunks only when supported, and execute actions only after a complete validated response.

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

- Alternating source/test reads must retain useful bounded context.
- Changed file hashes must invalidate stale cached content.
- Incomplete streamed JSON must never execute.
- Ambiguous remote inference must remain spent and owned.
- Hostile source text must never expand executable authority.

## Current implementation and dependencies

Require the Stage01 contract receipt. This stage may run alongside Stage02 in its own worktree. It consumes the agreed `Integration.executionBase(goalId)` contract, implemented by Stage02; do not edit integration internals independently. Use an injected resolver in isolated tests until the integration commit is available, then run combined tests.

Read `src/harness/coding.mjs`, `worker.mjs`, `provider.mjs`, `src/adapters/deepseek-http.mjs`, and `src/project/workspace.mjs`. CodingAdapter currently reads only `cp.paths` on each model phase. A model alternating between a source file and its test loses the previously supplied file, uses repeated read actions, and can exhaust the ten-exchange attempt boundary. This is a verified design defect, not permission to remove exchange/request limits.

Current bounds:128KiB per text file;512KiB serialized read context and model result; two edited files/24576 content bytes per action; ten exchanges per coding attempt; default five attempts/fifty model requests; task deadline capped by parent. `LocalProvider.complete()` uses `stream:false` and returns completed content, model, optional usage, and finish reason. Worker reserves a request before sending; failed or ambiguous remote inference remains spent and may retain uncertain ownership.

## Ownership and interface contract

Own CodingAdapter, LocalProvider, corresponding adapter tests, and narrow Worker instrumentation. Stage02 owns integration/native state. Coordinate Worker changes via the integration owner; do not merge overlapping unreviewed rewrites.

Use version1 normalized activity and correlation fields from Stage01. Keep provider result compatibility: `{content,model,usage,finishReason}`. Add an optional visible-output callback/event sink rather than forcing callers to handle partial actions. A streaming result is still incomplete until the provider has a complete valid response and the coordinator saves it. Use the existing request reservation ID as the chunk correlation; retries get their own reservation and never overwrite prior partial evidence.

Checkpoint working context as bounded selection metadata and hashes. Persist path order/recency and execution-base identity; re-read through Workspace before inference to revalidate scope and current contents. Do not store an unbounded transcript, read arbitrary files from a path in model output, or trust cached source text after external changes.

## Tasks and test-first sequence

### Task 1: Reproduce context oscillation and pin bounds

- [ ] Add RED tests with a provider fixture requesting source, then test, then submitting a repair requiring both. Assert the third request contains both current files and their hashes.
- [ ] Add tests for new-file missing content, deleted files, binary/symlink/secret paths, exact-directory rejection, oversized individual files, and serialized-context overflow.
- [ ] Keep the first automatic inventory selection small as today; later explicit read selections accumulate within the existing byte bound. Do not expose all project files automatically.
- [ ] Define deterministic eviction: most recently requested/read files retained first; evict least recently used older entries until the serialized context fits. A newly requested set that cannot fit on its own fails explicitly rather than silently dropping requested files.
- [ ] Preserve deterministic ordering and record evictions as captured context events. No newly selected path becomes a write permission.
- [ ] Run `node --test test/harness-adapters.test.mjs` and the new context tests to confirm RED before implementation.

### Task 2: Checkpoint and recover the working set

- [ ] Implement checkpointed path/hash metadata with a version marker and original execution base. Existing checkpoints with only `paths` are read compatibly as the seed working set.
- [ ] Before inference, re-read selected files through Workspace and refresh their hashes. After applied edits, invalidate affected cached hashes; never send pre-edit content as current.
- [ ] On revised approved scope, remove no-longer-readable entries before forming context, retaining durable prior evidence rather than deleting it.
- [ ] On restart, reuse completed request results under the same request key and checkpoint; do not send inference again because UI output delivery was interrupted.
- [ ] Replace Worker coding-base initialization with the Stage02 resolver. Persist the selected SHA through the existing boundary before the adapter begins; blocked resolver output must not become a fallback HEAD.
- [ ] Test restart between context save and request reservation, after response save and before phase update, after edits and before checks, and during a same-task revision.
- [ ] Commit the context fix separately after focused tests pass.

### Task 3: Capture actual actions

- [ ] Add named events for request reserved/started/completed/failed, files read, context refreshed/evicted, edit proposed/applied, checks started/passed/failed, question/checkpoint/yield, and candidate saved.
- [ ] Include task/goal/request correlations and actual actor/model where known. Deduplicate completed-operation replay so a recovered result does not appear as a new model request.
- [ ] Store bulky output as bounded allowlisted evidence referenced by IDs, not arbitrary private paths or oversized event payloads. Keep summaries readable and escaped.
- [ ] Do not log private connection configuration, HTTP authorization, system credentials, or hidden reasoning. Model-visible output and source contents remain project-private runtime evidence.
- [ ] Use durable event sequence rather than wall-clock order alone; two events can share a timestamp.

### Task 4: Probe and implement bounded streaming

- [ ] Add local HTTP fixtures for complete SSE, split UTF-8/codepoint boundaries, multiple chunks per read, malformed events, missing terminal marker, oversized content, server error, client disconnect, timeout, and no streaming support.
- [ ] Probe the configured service with one bounded approved request. Record support, actual model, request reservation/spending, and result. Do not change runtime settings or assume two Sparks mean two inference slots.
- [ ] If supported, parse bounded SSE and emit visible content chunks in order. Keep reasoning fields excluded. Bound assembled content by the existing512KiB provider-result ceiling and keep chunk/evidence limits explicit.
- [ ] If unsupported, use completed responses and show request-running status. Record fallback capability so later requests do not repeatedly spend probing calls.
- [ ] Never parse partial JSON as an action; malformed/truncated final responses follow existing bounded retry behavior. An interrupted uncertain request remains spent/owned even if some content arrived.
- [ ] Confirm observer backpressure cannot block checkpoints or free ownership. Drop/coalesce only nonessential presentation updates, never reservations, results, or recovery events.

## Review, verification, and gate

Run focused adapter/transport tests, `test/harness-crash.test.mjs`, and `npm test` after combined integration. Test a hostile page/source telling DeepSeek to run commands or invoke Codex; it remains data. Test DeepSeek-only mode encountering a question: the user receives it, no native answer/reviewer fallback runs. Test source/test retention after a real failed check and a model repair, not only a synthetic working-set utility.

The receipt separates fixture streaming tests from live support evidence and records requests including the probe. Gate requires reproducible repaired context behavior, preserved limits/recovery, captured activity, and honest streaming/fallback. A lack of streaming support is an explicit service limitation with completed-output fallback; it is not license to invent live tokens. Downstream observer agents consume event schemas and evidence IDs, not raw backend journal paths.

## Required handoff receipt

Use the shared receipt format in README.md. Include stage/objective; prerequisite and delivered commit SHAs; files/interfaces changed; exact test commands and exits; live versus fixture evidence; requests/usage where known; preserved IDs/deadlines/counters; artifact paths and SHA256 hashes; compatibility/rollback notes; limitations/blockers; and acceptance `passed` or `incomplete`. Do not mark this stage passed because this document exists. Keep private receipt details in local runtime artifacts and publish only sanitized summaries.

## Exact stage `/goal` prompt

> Complete Stage 03. Repair bounded DeepSeek working context and add correlated execution evidence using Stage 01 contracts. Preserve source scope, request reservations, deadlines, and counters. Demonstrate that relevant source/test context survives successive reads and restart, while stale content is refreshed. Probe streaming support without runtime changes; implement bounded visible-output streaming only if supported, otherwise provide an honest completed-output fallback. Test hostile/malformed output, interrupted requests, context bounds, cancellation, and checkpoint recovery. Do not add automatic Codex calls or accept partial streamed actions.
