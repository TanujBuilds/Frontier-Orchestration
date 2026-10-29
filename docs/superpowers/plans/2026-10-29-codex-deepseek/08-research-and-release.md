# Stage 08 — Spark Research Gates and Final Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete original-source research and disconnected-execution gates, then promote and verify the reviewed personal installation with recoverable state.

**Architecture:** Reuse existing self-hosted SearXNG and Spark research runtime, inspecting preserved evidence before spending new requests. Keep research backend ownership separate from Mac coding, collect checksummed artifacts, and promote immutable package versions only after every required gate passes.

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

- Search hostname counts must not masquerade as independent domains.
- A partial report at a budget cap must remain explicitly partial.
- Disconnected completion needs remote evidence and checked collection.
- Final promotion must not precede unresolved acceptance gates.
- Rollback must not restore an old database to regain budgets.

## Current implementation and dependencies

Evidence inspection may begin before Stage07 finishes; final promotion requires its accepted receipt and exact candidate hash. Read `.agents/skills/deep-research/{SKILL.md,references/verification.md,references/operations.md}`, deployment templates, research_gate.py, reader/provider/worker/CLI scripts, `src/harness/research.mjs`, and research tests. Read private memory for actual machine connectivity and artifact paths without copying them into tracked output.

Historical facts recorded2026-10-29 require rechecking: a separate official ARM64 SearXNG container was deployed CPU-only with one CPU,1GiB memory,64PIDs, no GPU requests, and loopback-only exposure. The two search passes structurally qualified9/10 and8/10 queries, approximately1906seconds apart. The second pass still needs independent semantic review. Structural qualification in research_gate.py counts hostnames; manual review must count distinct registrable domains and assess actual relevance. A repaired unchanged ten-page reader corpus yielded8/10 useful extractions; failures and original attempts were preserved. These records are evidence leads, not automatically current passed gates.

The two Sparks serve one distributed DeepSeek model. This application must not restart/reconfigure its containers, alter model weights/tuning, change SSH/Tailscale authentication, or install a different search provider. Keep CPU research work separate and bounded. Earlier personal research worker deployment remained incomplete; do not claim lingering/service persistence merely because a one-off gate process ran remotely.

## Ownership and interfaces

Own research semantic assessment, live pilot receipts, candidate promotion scripts/runbook, product guidance updates, and final restart verification. Focused application defects return to their code owner with preserved evidence. No unrelated infrastructure tuning or experiment-lab implementation belongs here.

Use approved research submit/status/stop/resume/collect operations with stable submission IDs. A submitted question binds exact question, public-source scope, budget, and absolute parent deadline. Preserve request reservations before network/model dispatch; retries and ambiguity remain spent. Source IDs and saved text establish citation provenance, not independent factual certification. Existing inaccessible PDFs/login/JavaScript-only pages remain explicit evidence gaps.

Install immutable package versions with private configuration/state outside their directories. Personal skill/MCP/service registration points to the reviewed version. Keep a versioned pointer/config backup and database compatibility record; rollback cannot replace a newer state database with an old copy to recover spending.

## Tasks and test-first sequence

### Task 1: Verify search gate evidence

- [ ] Locate existing private artifacts and verify their saved SHA256 hashes, timestamps, original query IDs, and exact raw results before rerunning anything.
- [ ] Inspect actual container image architecture/digest and CPU/memory/PID/network/device limits. Record sanitized values and tested image digest, never private endpoints or credentials.
- [ ] Independently select three relevant results per qualifying query with distinct registrable domains and at least one primary source. Save the selected URLs/source reasons and failures for both passes.
- [ ] Confirm each pass has at least eight qualifying queries, exactly ten representative queries, and interval at least1800seconds. Do not count multiple service subdomains as independent domains.
- [ ] Verify reader extraction on the original ten public documentation/repository/article pages: useful text, provenance, hashes, and at least eight successes. Preserve rejected oversized/redirect/empty pages; supplemental examples do not replace failed original cases silently.
- [ ] If semantic assessment fails the gate, report measured limitations and preserve evidence. Do not silently loosen thresholds or change providers. Existing approved SearXNG may be repaired within scope; provider changes require a separate decision.

### Task 2: Complete real original-source research pilot

- [ ] Prepare a question comparing durable queue approaches for one-host AI workers, with explicit acceptance and public-source scope. Use default two-hour/30search/50download/20model-call caps unless a narrower approved envelope applies.
- [ ] Reserve the last three model calls for drafting, self-check, and one repair. Include retries and unsuccessful/ambiguous requests in the same totals.
- [ ] Run through the installed candidate backend and save report.md, structured claims/evidence, sources/retrieval times/content hashes, execution receipt, failures, and unanswered questions.
- [ ] Validate citation membership and saved supporting passages before bounded self-check. A model self-check is not independent certification.
- [ ] Check five material claims and the resulting recommendation against original sources directly. Record each claim, original source URL, supporting passage/source ID, and qualified verdict. Identify contradictions or unsupported recommendations explicitly.
- [ ] If repair is needed, use remaining reserved calls and original deadline. A partial report at a limit remains explicitly partial, not accepted as a completed research pilot.

### Task 3: Disconnected completion and persistent worker

- [ ] Verify the research worker's user systemd service template, private config permissions, actual user lingering, and one-worker ownership before persistent activation.
- [ ] Submit the bounded approved pilot; disconnect the Mac submission SSH/session while the Spark worker continues. Record remote start/checkpoint/completion timestamps and process/service evidence.
- [ ] Reconnect and collect using the same job/submission identity. Verify every artifact checksum before exposing reports to the coordinator/dashboard. Repeated collection returns the same immutable artifacts.
- [ ] Test worker restart around request reservation, result saving, and finalization on disposable jobs. Completed requests are reused; ambiguous requests are spent and require reconciliation.
- [ ] Demonstrate empty-backlog drain stops or idles according to the deployed service contract without inventing recurring research. Startup-scout deferral remains best effort.

### Task 4: Promote and verify final components

- [ ] Review Stage07 receipt and all stage gates; unresolved gate status blocks final promotion, even when local tests pass.
- [ ] Build/verify a final immutable package from the reviewed committed integration revision; record all file hashes and dependency/runtime versions.
- [ ] Install personal skill entries and one MCP registration, Mac user LaunchAgent, and approved private observer access. Preserve unrelated owner configuration and existing jobs. Do not enable public hosting/Funnel.
- [ ] Verify actual native-host discovery/calls on the final version, viewer-only browser access, and phone reachability where available. If host refresh or user authentication is required, state exactly what remains.
- [ ] Restart Mac coordinator and Spark research service, then verify ownership, queues, counters, deadlines, questions, candidate references, artifact allowlists, and package identity persisted correctly.
- [ ] Demonstrate rollback procedure on a disposable candidate: revert runtime pointer only when schema-compatible, retain spending/state/events, and refuse unsafe downgrade. Never erase failed records or recreate exhausted jobs under new IDs.
- [ ] Update tracked product guidance for Codex-first operation and legacy distinctions. Update ignored local memory with dated verified installation facts, no credentials.

## Release gate and required receipt

Run all applicable Node/Python/browser suites after final changes and independent review. Do not rerun expensive live gates without a changed concern; reuse valid immutable evidence with correct version applicability. Record actual DeepSeek/search/download/reviewer spending and unavailable native token accounting distinctly.

Final receipt lists all eight stage receipts and exact commits; package/image/runtime/dependency versions; passed fixture versus live gates; five-claim original-source assessment; disconnected completion evidence; collected file hashes; installed service/MCP/skill identities; restart/rollback results; remaining limitations. All gates must pass for complete status. Authentication, deployment, missing visual review, or network blockers keep the release incomplete even if code implementation is finished.

Do not merge to the primary branch, push, publish artifacts publicly, add providers, or finish the experiment lab. Deliver a reviewable isolated local branch and exact blockers when incomplete. This stage closes the approved package only; it does not assert universal learning improvement or monitoring across every external model client.

## Required handoff receipt

Use the shared receipt format in README.md. Include stage/objective; prerequisite and delivered commit SHAs; files/interfaces changed; exact test commands and exits; live versus fixture evidence; requests/usage where known; preserved IDs/deadlines/counters; artifact paths and SHA256 hashes; compatibility/rollback notes; limitations/blockers; and acceptance `passed` or `incomplete`. Do not mark this stage passed because this document exists. Keep private receipt details in local runtime artifacts and publish only sanitized summaries.

## Exact stage `/goal` prompt

> Complete Stage 08. Verify the existing Spark search artifacts and finish semantic search, extraction, real research, five-primary-claim, disconnected-completion, and checksummed-collection gates. Preserve failures and do not change search providers or model runtime settings without separate authorization. After all required gates pass, promote the reviewed versioned package into the personal skills/MCP/service installation and verify restart recovery and private observer access. Produce final checksummed receipts and rollback instructions. If an external dependency prevents a required gate, preserve state and report the release incomplete; do not claim completion from local tests alone.
