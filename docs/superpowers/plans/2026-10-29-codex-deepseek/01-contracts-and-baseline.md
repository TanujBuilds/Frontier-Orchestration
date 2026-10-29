# Stage 01 — Contracts, Baseline, and Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish tested, versioned contracts and a reproducible baseline so independent stage agents can implement without guessing shared semantics.

**Architecture:** Reuse the existing durable coordinator, generic SQLite records, journaled Git workspaces, and authenticated MCP bridge. Add pure collaboration validators and fixtures before changing execution semantics; retain legacy native ownership until its existing lifecycle finishes.

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

- Unknown versions/fields must fail without changing approvals.
- Native host IDs must not imply stronger authentication.
- Legacy native ownership must survive additive records.
- Explicit unavailable models must not silently fall back.
- Idempotency conflicts must fail rather than refresh deadlines.

## Current implementation and dependency state

This is the first implementation stage. Its prerequisite is the approved plan, not an assumed earlier stage receipt. Verify the source commit against the approved base in CONTEXT.md and record any reviewed successor. The integration owner creates `codex/collaboration-package`; implementers use isolated `codex/collaboration-*` branches. Never switch or reset another agent's checkout.

`src/harness/contracts.mjs` normalizes manifests and mode/capability policies. `Coordinator` owns approval hashes, deadlines, attempts, request reservations, questions, dependencies, and events. `Store` uses generic `records`, `commands`, `submissions`, `events`, and `requests`; it already provides WAL and FULL synchronization. Avoid inventing a second database or scheduler. `Dispatcher` in `tools.mjs` is the MCP/API tool inventory, while `mcp.mjs` forwards stdio calls to the authenticated loopback service.

Native coding is currently special: `Integration.beginNative()` grants a task the goal integration checkout; `finishNative()` checks, commits, and accepts there directly. An existing goal may retain `integrationOwner` or an `integrationSealed` partial. The software upgrade must not reinterpret these records as new parallel candidates. `Worker.tick()` currently obtains a coding execution base by opening that integration checkout and reading HEAD, including a native-owner exception; Stage 02 replaces that race with a locked resolver.

## Ownership and interfaces

**Create:** `src/harness/collaboration-contracts.mjs`, `test/harness-collaboration-contracts.test.mjs`, and sanitized JSON fixtures below `test/fixtures/collaboration/`. **Modify only as needed:** current contract discovery and persistence-version handling. Leave provider transport, integration mechanics, and dashboard implementation to their owning stages.

The new module exports `COLLABORATION_VERSION = 1`, `OBSERVER_LIMITS` with `evidenceBytes:32768` (and the tested page defaults/maxima), and these pure functions: `normalizeAgentRegistration(raw)`, `normalizeProgressReport(raw)`, `normalizeModelSelection(raw)`, `normalizeNativeCandidate(raw)`, `normalizeHelpRequest(raw)`, `normalizeObserverQuery(raw)`, and `normalizeActivityEvent(raw)`. These validate shape and normalize copies; coordinator methods perform state/permission checks. Reject unknown fields and unsupported versions rather than dropping them. Reuse existing identifier, integer, text, canonicalization, and hashing helpers. The contract fixture JSON is the authority shared by later agents; changes require integration-owner review before dependent implementation.

The exact version1 wire shapes are below. Required nullable fields stay explicit; use the fixture defaults only where stated. IDs are bounded to120 characters; evidence/artifact arrays to100 entries. Model metadata provides no executable provider authority.

```text
normalizeModelSelection:
  {requested:null|string, resolved:null|string}
normalizeAgentRegistration:
  {version:1, taskId:string, hostAgentId:null|string,
   role:implementer|explorer|reviewer|supervisor,
   actor:codex|deepseek, model:{requested,resolved}}
normalizeProgressReport:
  {version:1, agentId:string,
   status:running|waiting|completed|blocked|stopped,
   summary:string, evidenceIds:string[]}
normalizeNativeCandidate:
  {version:1, taskId:string, baseCommit:40hex, worktree:absolute,
   commit:null|40hex,
   status:active|awaiting_review|ready_to_integrate|integrated|partial,
   checks:array}
normalizeHelpRequest:
  {version:1, taskId:string, questionId:string,
   helperTaskId:string, reason:string}
normalizeObserverQuery:
  {goalId:null|string, actor:null|codex|deepseek,
   after:0..Number.MAX_SAFE_INTEGER, limit:1..200(default50)}
normalizeActivityEvent:
  {version:1, seq:integer, at:integer, goalId:null|string,
   taskId:null|string, agentId:null|string, requestId:null|string,
   type:string, actor:null|codex|deepseek,
   provenance:captured|reported|coordinator,
   summary:string(max2000characters), artifactIds:string[]}
```

Registrations acquire their goal and durable registration ID from the coordinator after validating task membership; neither belongs in the registration input. Native host IDs are correlation data, not credentials. Progress is reported activity and cannot prove quiescence. Candidate paths are private runtime data and never arbitrary reader authority. Help links an existing question to an ordinary helper task; its objective/permissions/dependencies come from normal task submission, not executable fields in this link. Evidence window validation remains a separate observer interface capped32768 bytes. Activity sequence is durable; strings remain escaped data.

Stage 02 produces `Integration.executionBase(goalId): Promise<string>`, returning a committed SHA under the goal journal lock after recovery. It refuses active legacy native writers and sealed partial integration state. Stage 03 consumes it through `Worker.integration`; the worker does not bypass it by reading HEAD itself. Resolver refusal is a recoverable blocked condition, not permission to select the original repository HEAD.

## Tasks and test-first sequence

### Task 1: Capture baseline and host capabilities

- [ ] Read AGENTS.md, PRODUCT_CONTEXT.md, MVP.md, HARNESS.md, this document, and shared context. Read local memory if present without copying private settings into tracked output.
- [ ] Record `git rev-parse HEAD`, clean/dirty state, `node --version`, `python3 --version`, `codex --version`, and exact package lock versions. Probe `codex --help` and available native delegation APIs before claiming host support.
- [ ] Run `npm test`; run `python -m unittest discover -s test/research -p 'test_*.py'` in the documented pinned environment. Keep command exit codes and logs. A missing pinned Python environment is an explicit prerequisite, not a reason to install arbitrary dependencies globally.
- [ ] Record supported native spawn, model override, worktree path, interruption, and read-only reviewer mechanisms. Distinguish native host capability from role instructions. Do not change global concurrency, permissions, authentication, or MCP settings.

### Task 2: Define and test additive contracts

- [ ] Write RED tests for valid version1 fixtures, unsupported version, extra command/credential fields, nonfinite numbers, invalid IDs, excessive output, malformed model selection, and fabricated artifact path authority.
- [ ] Run `node --test test/harness-collaboration-contracts.test.mjs` and confirm failures reflect missing contracts rather than unrelated imports.
- [ ] Implement the pure validators and normalized-copy behavior. Ensure caller input cannot mutate normalized objects or later change approved hashes.
- [ ] Assert max200 observer page size, max32768 evidence window, captured/reported distinction, and explicit native candidate layout.
- [ ] Re-run new and existing contract tests, then commit the contract module and fixtures as an independently reviewable change.

### Task 3: Pin migration and integration behavior

- [ ] Add tests loading legacy native active, stopped, released/sealed, and accepted records. Omitted layout retains historical behavior; no migration may erase `integrationOwner` or unseal a partial.
- [ ] Verify mutation key replay returns the previous result and conflicting input under the same key fails. Cover process restart after intent but before completion.
- [ ] Document exact existing limits: Workspace content128KiB per UTF-8 file, serialized read context512KiB, model result512KiB, edit batch two files/24576 content bytes, ten context exchanges per attempt. No file-count limit is implied by `readFiles()`; retain byte bounds.
- [ ] Record the exported contracts and execution-base promise in the stage receipt. Stage 02 owns implementing and testing the resolver, including legacy-writer refusal; Stage 03 owns consuming it. Stage01 must not introduce a permanently failing test against a resolver not implemented until Stage02.
- [ ] Run relevant baseline suites again only after changed code, then commit compatibility tests separately.

## Recovery, review focus, and completion gate

Test an active legacy writer during upgrade, a malformed explicitly requested model, a claimed but nonexistent host capability, an idempotency key reused with different content, and a cursor outside valid bounds. Include each as a named regression case. Never modify a historical approved manifest to add new fields; use additive execution metadata or a separately approved manifest version.

This gate passes only when contracts, fixtures, baseline results, and migration tests are committed and reviewed. Merely documenting desired behavior does not pass it. The receipt lists exact base/delivered commits, tool versions, host capabilities verified versus unavailable, test commands/exits, artifact hashes, and any dependency block. Stages02/03 consume this receipt's commit rather than guessing which branch is current.

## Required handoff receipt

Use the shared receipt format in README.md. Include stage/objective; prerequisite and delivered commit SHAs; files/interfaces changed; exact test commands and exits; live versus fixture evidence; requests/usage where known; preserved IDs/deadlines/counters; artifact paths and SHA256 hashes; compatibility/rollback notes; limitations/blockers; and acceptance `passed` or `incomplete`. Do not mark this stage passed because this document exists. Keep private receipt details in local runtime artifacts and publish only sanitized summaries.

## Exact stage `/goal` prompt

> Complete Stage 01 of the Codex + DeepSeek collaboration package. Read its stage document, shared context, current project guidance, and baseline verification records. Establish the isolated integration branch and tested contracts for agents, models, candidate ownership, execution bases, progress, help requests, and observer access. Preserve existing approvals and active legacy ownership. Verify actual native host capabilities and document their limits without changing global configuration. Produce passing contract/compatibility tests and a checksummed stage receipt. Do not implement later stages or claim the overall package is complete.
