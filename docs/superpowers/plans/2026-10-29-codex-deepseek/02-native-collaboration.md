# Stage 02 — Parallel Native Implementation and Collaboration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow independent native Codex candidate writers alongside DeepSeek while keeping main Codex acceptance and serialized integration authoritative.

**Architecture:** Add explicit candidate_v1 native workspaces beside the existing legacy native path. Reuse journal locks, effect idempotency, immutable execution bases, trusted checks, and normal review/integration instead of creating a parallel scheduler.

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

- Concurrent writers must have distinct candidate checkouts.
- Stale bases and overlapping edits must not overwrite accepted work.
- A missing progress report must not release ownership.
- Helper dependencies must not create cycles or evade budgets.
- Git success before result saving must recover idempotently.

## Current implementation and dependencies

Require the accepted Stage01 receipt and exact contract commit before editing. Read its fixtures and `src/harness/integration.mjs`, `coordinator.mjs`, `tools.mjs`, `worker.mjs`, and `src/project/{workspace,journal,sandbox}.mjs`. Current native execution owns the goal integration checkout and completes directly into accepted state. That path is valid for historical jobs but cannot support multiple concurrent native writers safely. `g.integrationOwner` and `integrationSealed` are meaningful durable locks, not obsolete fields to delete.

The new path is opt-in through `native_start` with `layout:'candidate_v1'`. Omitted layout retains legacy semantics, especially for already active native tasks. New package skills always request the new layout. Do not migrate old approvals or switch an existing task's checkout behind its owner.

## Ownership and interfaces

Own native workspace/integration methods and tests: `src/harness/integration.mjs`, native tools in `tools.mjs`, relevant coordinator native metadata, and `test/harness-integration.test.mjs`. Stage03 owns provider/coding context; agree on Worker edits with the integration owner. Put a narrow helper module beside integration if required to keep journal lifecycle code understandable, without refactoring unrelated code.

Consume Stage01 validators. Produce `Integration.executionBase(goalId): Promise<string>`, consumed by both new native starts and Worker coding initialization. Under the goal journal lock: check active legacy ownership/sealed partial, initialize/recover the integration workspace, and return its committed SHA. Persist the task's selected base exactly once before writes. Revisions/resumption reuse it unless an explicit approved rebind records a new candidate generation without refreshing spending.

`native_start` adds optional layout, registration/model metadata, and uses existing idempotent asynchronous-operation conventions. `native_finish` on candidate_v1 saves checks, scope-validated diff, checkpoint/commit, and summary; it transitions to `awaiting_review`. Main Codex then invokes existing review/integration operations. A child cannot accept its own candidate by submitting a completion summary. Role descriptions and native IDs are cooperative correlation only: the host may expose the same tools to children, so do not advertise tool-level isolation that does not exist.

Add registered-agent/progress and approved helper-link operations through Dispatcher. DeepSeek proposes help through its existing ask_supervisor question; main Codex submits an ordinary narrower helper task and then records the version1 link. Mutations require existing idempotency keys. Help acceptance creates an ordinary narrower assignment, consumes maxTasks, and links the original task/question. Preserve original questions, answers, feedback, deadlines, attempts, and request counts. Never put an executable command in a help request. Native explicit model choice must be verified against host support; unavailable explicit selection fails visibly rather than silently choosing another model. Unspecified models inherit parent selection and are labelled inherited until observed.

## Tasks and test-first sequence

### Task 1: Committed execution bases and isolated candidates

- [ ] Add RED tests proving two candidate_v1 starts return distinct worktrees/branches with the same immutable committed base while neither claims the goal integration checkout.
- [ ] Add refusal tests for an active legacy native writer, sealed partial, unrecovered journal, and unknown integration HEAD. Verify no candidate is dispatched from a dirty fallback source.
- [ ] Run the focused integration suite and inspect the expected failures.
- [ ] Implement the locked execution-base resolver and candidate journal lifecycle. Reserve identity/intent before filesystem effects and recover a successful worktree creation after a crash.
- [ ] Preserve old native_start behavior when layout is absent; add explicit tests for old active records and legacy completion.
- [ ] Verify candidate startup cannot run outside parent mode, approved paths, dependencies, deadline, or stopped state. Commit this unit after GREEN focused tests.

### Task 2: Candidate finish, review, revision, integration

- [ ] Add RED tests that finishing a candidate does not accept it, mutate integration HEAD, or erase ownership before the writer has finished.
- [ ] Scope-check all tracked/untracked changes and protected checks against the immutable start base. Run checks through CheckRunner, not worker-provided shell strings.
- [ ] Save candidate snapshot/commit and check evidence idempotently. Follow actual journal recovery conventions around commit-before-save crashes.
- [ ] Adapt integration to consume either worker coding candidates or candidate_v1 native candidates. Keep a single serialized target journal lock and run combined project checks after import.
- [ ] Make conflicts explicit. Two candidates editing overlapping lines must not overwrite each other; unchanged matching changes may be reused idempotently. Retain both candidates for resolution.
- [ ] Same-task revision reopens its candidate generation with review feedback while preserving task ID, original deadline, request spending, attempts, and review counters. Never submit a replacement task merely to reset a failed attempt.
- [ ] Test crash before/after acceptance recording, imported edit save, checks, checkpoint commit, and final task state. Replaying with the same key must not produce extra commits.

### Task 3: Native registry and linked help

- [ ] Add RED tests for registrations, model inheritance, explicit unavailable models, duplicate host correlation, unknown task, wrong mode, and status reports that try to authorize completion.
- [ ] Register agents before dispatch; save last reported phase/message and observed timestamps without manufacturing a heartbeat or private transcript.
- [ ] Implement helper creation through normal task_submit rules, followed by a version1 help link {taskId,questionId,helperTaskId,reason}. Reject budget exhaustion, cross-goal dependencies, and cycles where the helper waits on its own blocked parent.
- [ ] A parent awaiting a helper releases DeepSeek execution only after verified quiescence. Helper integration records a linked result and feedback; returning to the parent reuses its same assignment and limits.
- [ ] Confirm implementation agents do not consume optional reviewer-run reservations; their ordinary tasks still count against the approved goal task cap.

### Task 4: Stop, partials, and takeover

- [ ] Add tests for genuine saved DeepSeek edits followed by stop/quiescence, frozen snapshot verification, and transfer into a separate native candidate.
- [ ] Keep original worker evidence immutable after takeover. Native Codex never edits the worker-owned checkout.
- [ ] Native stop requests are requests, not proof editing ceased. Require host interruption/completion evidence or explicit supervised quiescence before release; retain ownership on uncertainty.
- [ ] Preserve candidate partials and seal/retire historical legacy partials using their old rules. Missing recent progress cannot free a writer lock.
- [ ] Re-run `node --test test/harness-integration.test.mjs test/harness-state.test.mjs test/harness-crash.test.mjs`, then `npm test`. Commit reviewed units separately.

## Recovery and completion gate

Exercise two actual native candidate processes and one DeepSeek fixture task, not merely manually fabricated status records. Verify their worktrees differ and main integration is serialized. Add interruption cases around worktree creation, candidate checkpoints, stop, review, and target Git commits. Report host limits honestly: all native workers are subject to actual host capacity and approved assignment budgets; this stage does not promise unlimited threads or authoritative isolation across arbitrary Codex chats.

The gate requires distinct candidates, supervisor review, checked idempotent integration, helper handoff/resumption, genuine takeover, legacy compatibility, and passing crash tests. The receipt records base/candidate/integration SHAs, task IDs, preserved spending/deadlines, checks, native accounting availability, registered host IDs where observed, and exact limitations. Stage03 receives the final resolver signature/commit; Stage04 receives documented tools and worker instructions.

## Required handoff receipt

Use the shared receipt format in README.md. Include stage/objective; prerequisite and delivered commit SHAs; files/interfaces changed; exact test commands and exits; live versus fixture evidence; requests/usage where known; preserved IDs/deadlines/counters; artifact paths and SHA256 hashes; compatibility/rollback notes; limitations/blockers; and acceptance `passed` or `incomplete`. Do not mark this stage passed because this document exists. Keep private receipt details in local runtime artifacts and publish only sanitized summaries.

## Exact stage `/goal` prompt

> Complete Stage 02 using the accepted Stage 01 interfaces. Implement isolated native candidate worktrees, registered parallel agents, model inheritance/overrides, separate candidate completion and supervisor acceptance, linked help assignments, safe interruption, and takeover. Demonstrate concurrent native implementation alongside DeepSeek without shared checkout writers. Preserve legacy active tasks and all spending/deadlines. Test crashes, stale bases, conflicts, revision, and idempotent integration. Return reviewed commits and evidence; never treat a stale progress report as proof that editing stopped.
