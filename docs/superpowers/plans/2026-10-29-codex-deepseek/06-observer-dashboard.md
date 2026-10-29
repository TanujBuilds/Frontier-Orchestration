# Stage 06 — Split Overview and Timeline Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner understand Codex and DeepSeek work through a read-only split overview, common timeline, and expandable evidence.

**Architecture:** Consume only Stage05 observer reads and viewer sessions. Extend the established dark Carbon/Nunito assets into desktop actor columns and a shared chronological timeline, with stacked mobile views and stable incremental updates.

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

- Polls must not close evidence, steal focus, or move reading position.
- Native reported progress must remain distinct from captured DeepSeek work.
- Model output and filenames must render as inert text.
- Phone layout must preserve timeline and keyboard access.
- No visible or hidden dashboard path may mutate execution.

## Current implementation and dependencies

Require accepted Stage05 interfaces, fixture server, and viewer credentials supplied privately. Stage04 may still be completing package validation; do not copy its runtime or build a second API. Read `src/harness/dashboard/{index.html,app.js,style.css}`, current `test/harness-api.test.mjs`, existing browser evidence scripts/tests, and project PRODUCT/DESIGN context if present.

The current dashboard is an operating console with editable forms and control actions. It once lost open assignment drafts when polling rerendered the page; commit714ed31 guarded editable focus and open forms. The selected product changes the primary surface to observation, but recurring updates can still close expanded evidence or move keyboard focus. Treat update stability as a regression requirement, not a styling refinement.

The user rejected a replacement chat app. Codex remains chat, approvals, steering, stop, and integration. Do not add a composer, chat sidebar, or dashboard workflow that asks users to paste instructions into a second assistant. Attention cards explain what needs action and direct the owner back to Codex without making decisions.

## Ownership and interfaces

Own dashboard assets and browser tests. Do not alter scheduler, mode policies, observer authorization, or tool input contracts to simplify rendering. If required data is missing, report the interface gap to Stage05 and add a coordinated test rather than calling operator tools from JavaScript.

Consume observer_snapshot, observer_timeline, observer_evidence and their Stage05 schemas. Viewer login/session handling must not obtain the operator bearer key. All dynamic text, including titles, filenames, model output, check results, and error messages, uses safe text rendering. Artifact links come only from saved allowlisted metadata and respect authentication/checksum behavior.

Deliver: a goal selector; all-goal overview; desktop Codex and DeepSeek columns; actor/task cards; top attention and connection state; shared timeline; actor filters; expandable event output; agent/task detail panel; mobile stacked layout. Show the number of registered running native agents, not every process or unrelated Codex chat. Distinguish requested and observed model identities and unknown usage.

## Tasks and test-first sequence

### Task 1: Establish fixture-backed layout and visual gate

- [ ] Load frontend-design/impeccable guidance and local design context. If a helper cannot run, read existing design sources directly; do not escalate just to satisfy a cosmetic helper.
- [ ] Create a deterministic fixture view with two native agents and one DeepSeek worker, a blocked question, queued tasks, captured actions, reported progress, and a completed integration.
- [ ] Build the basic1280px desktop composition and390px mobile stack using existing Nunito font licensing/assets and Carbon dark tokens. Avoid unnecessary dependency/framework replacement.
- [ ] Capture fixture-backed screenshots of both layouts. Label them fixtures; a screenshot of made-up activity is not live evidence.
- [ ] Present screenshots to the owner for layout feedback before completing the frontend. Explain this gate comes from the approved Stage06 plan. Backend and other stage work can continue while feedback is pending.
- [ ] Record approved layout decisions; keep screenshots/artifacts outside tracked public docs when they contain private fixture/runtime content.

### Task 2: Render actual actor work and handoffs

- [ ] Write browser assertions for backend-driven status and counts before wiring the corresponding rendering.
- [ ] Render native reported assignment, role, model if observed, last report/time, waiting reason, and candidate/review state. Label stale/missing native reports without declaring quiescence.
- [ ] Render DeepSeek current task/action/request, queue order/priorities, question/check status, and completed visible output where available. If streaming unsupported, show running/completed accurately.
- [ ] Build shared chronological steps from durable sequence order. Human summaries are primary; expand raw output and structured evidence on demand.
- [ ] Agent/task details show relevant history, handoffs, checks, diff/evidence links, revisions, and integration results. Show unavailable evidence explicitly rather than substituting generic output.
- [ ] Keep approval/blocker notices read-only. Do not add hidden forms or direct mutation fetches behind apparently harmless controls.

### Task 3: Preserve navigation through updates

- [ ] Add RED tests that polling/reconnect does not reset goal/actor filters, close expanded steps, move keyboard focus, or jump scroll position.
- [ ] Update keyed rows/details incrementally or restore state by durable IDs. Do not rebuild the complete page on each event.
- [ ] Follow new activity automatically only when the user is already at the live edge. Otherwise show a new-events affordance without pulling them away from older evidence.
- [ ] On filter change reset timeline cursor and loaded rows correctly; abort obsolete requests so an earlier response cannot repaint another goal's details.
- [ ] On disconnection keep saved visible history, mark connection stale, and retry boundedly. On reconnect resume from the durable cursor and deduplicate repeated responses.
- [ ] Handle authentication expiry clearly without exposing tokens or erasing the owner’s current selection unnecessarily.

### Task 4: Accessibility and hostile content

- [ ] Verify semantic headings, labels, buttons, keyboard traversal, visible focus, and accessible expanded/collapsed state. A detail panel must not trap focus accidentally.
- [ ] Respect prefers-reduced-motion. Use restrained state transitions and no permanent decorative animation that implies activity when disconnected.
- [ ] Test long task/model names, empty queues, no registered agents, thousands of events, oversized evidence windows, partial UTF-8 output, and missing artifacts at both target widths.
- [ ] Inject HTML/script/terminal escape payloads through model output and task titles; assert they remain inert text and no network navigation or script execution occurs.
- [ ] Exercise viewer mutation-denial through actual browser requests as well as visual absence of controls. Browser tests must verify actual backend state is unchanged.

## Verification, completion gate, and handoff

Add reproducible `npm run test:observer` using pinned Playwright and a disposable local fixture service. Record browser/runtime versions and capture failures. Do not require the owner's live service/credentials for routine UI tests. Run existing Node suites after backend test-support changes.

The gate requires owner-reviewed desktop/phone composition, backend-driven actor counts/timeline/details, stable focus/scroll, reconnect, keyboard/reduced-motion behavior, inert hostile content, and server-enforced viewer restrictions. A static screenshot alone does not pass. Stage07 supplies actual live tasks; the dashboard must render them through the same code path as fixtures, with provenance labels retained.

Handoff includes screenshot artifact hashes, approved layout record, browser test command/results, API assumptions, accessibility checks, and limitations. Keep UI delivery separate from full package release; private phone reachability and final service restart are later gates. Do not claim the dashboard captures all Codex internal actions: it shows registered assignments and explicit reports only.

## Required handoff receipt

Use the shared receipt format in README.md. Include stage/objective; prerequisite and delivered commit SHAs; files/interfaces changed; exact test commands and exits; live versus fixture evidence; requests/usage where known; preserved IDs/deadlines/counters; artifact paths and SHA256 hashes; compatibility/rollback notes; limitations/blockers; and acceptance `passed` or `incomplete`. Do not mark this stage passed because this document exists. Keep private receipt details in local runtime artifacts and publish only sanitized summaries.

## Exact stage `/goal` prompt

> Complete Stage 06 against the Stage 05 observer API. Build the read-only Codex/DeepSeek split overview, shared timeline, and expandable agent/task evidence using the established Carbon/Nunito design. Obtain visual feedback on desktop and phone layouts before finishing the frontend. Use real backend states and label reported, captured, stale, uncertain, and fixture activity honestly. Verify filtering, expansion, reconnect, keyboard access, reduced motion, and stable focus/scroll at 1280px and 390px. Keep instructions and execution controls in Codex.
