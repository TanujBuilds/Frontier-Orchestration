# Verification record

## 2026-10-21 — Live API probe, handoff attempt, and browser timeline

- From the Mac, the head's Tailscale API returned HTTP 200 from `/v1/models` and advertised one model. A direct `/v1/chat/completions` request returned the requested short text, HTTP 200, and a normal completion shape. The local SSH forward was closed and the saved LAN route did not answer at that time.
- The original text workflow used real signed-in Codex planning and explicit plan approval. The coordinator logged the assignment sent to DeepSeek. The completion call then ended after about five minutes with a response-header timeout; no local answer or Codex review was recorded, and the job finished `failed` while preserving its earlier events. Subsequent head connections timed out, so this does **not** verify the full live handoff. The cause of the slow/stalled request is not established.
- A small two-stage UI pilot plan was shown and approved by exact plan hash against the clean prepared starter. Its background runner remains idle pending a stable endpoint and successful text handoff; the eight-hour run clock has not started.
- Added a read-only browser timeline over the existing local JSONL logs. A Mac browser smoke check loaded both a coding job and the failed text job without JavaScript errors or horizontal overflow at desktop/mobile widths. The API returned existing jobs and an event-listed PNG while rejecting an unlisted PNG. This viewer does not verify model quality or coding completion.
- The owner reported that AI Top 1's Tailscale connection had dropped and is restoring it. No Spark runtime setting was changed.
- After connectivity returned, both Mac routes to the head answered `/v1/models`, and a short completion returned the requested text. The first full LAN handoff again reached Node's implicit five-minute response-header cutoff. The Mac adapter was changed to use a request transport whose explicit ten-minute deadline covers the entire response, with a 32 MiB response limit. A short live completion through that transport succeeded.
- The next full text job completed with real DeepSeek answers on two attempts and real signed-in Codex reviews after each. Codex requested a missing bench-start timestamp after attempt 1; DeepSeek added it in attempt 2. Codex then identified an inconsistent consent rule, so the coordinator stopped at the one-revision limit with `needs_review`. The terminal and JSONL log contain both full answers, reviews, and final status. This verifies the live text loop and bounded revision behavior, but does not mean Codex accepted the design.
- The owner-approved two-stage coding pilot ran against the real DeepSeek service and finished `accepted`. Stage 1 used two DeepSeek attempts: the first produced the dark responsive task-board shell, and Codex spotted an oversized mobile textbox in its screenshot; the second fixed it. The protected layout check passed, Codex accepted the changed `src/` files, and the coordinator committed a stage checkpoint.
- Stage 2 used four DeepSeek attempts and no Codex coding rescue. One reply lacked structured content; another asked for generated review artifacts that the coordinator already handles. A Mac-side evidence handoff bug was found when the separate final Codex review saw only the empty stage-2 diff. The job was paused, the coordinator was corrected to include the accepted stage-1 checkpoint diff, and the same job resumed without rerunning stage 1. The final layout check passed, final desktop/mobile screenshots were recorded, Codex accepted the source and checkpoint diff, and the coordinator committed stage 2. The worktree was clean afterward. No Spark runtime setting was changed.
- This is a **narrow live coding proof** of the approved shell and layout check. The task controls are visual-only; interactions, persistence, a full accessibility audit, and the larger four-stage Night Shift release gate remain unverified. Codex explicitly noted that keyboard focus styling was defined in CSS but not demonstrated by the screenshots. Local model usage was reported; Codex CLI token usage is not yet measured, so token savings are not established.
- Final local verification: all 41 tests passed; `git diff --check` passed. The browser viewer reconstructed both accepted stages and the final event from the saved JSONL log. The final worktree was clean and contained two local checkpoint commits. No merge or publication occurred.

## 2026-10-21 — Offline handoff timeline

- The project CLI now replays and follows the persisted job log with `watch`. It displays stage assignments, worker responses, edits, checks, Codex reviews, checkpoints, waits, and final status. Fake jobs are visibly labeled.
- The full 39-test suite passed, including a live-tail test that waits for a complete JSONL record and replays a paused job through its later resumed completion. An existing fake detached job replayed correctly in the terminal.
- The Mac CLI is installed and signed in. Both previously observed direct head API routes refused connections during this check. The owner reports that the home Wi-Fi is down and both Sparks are offline; no current model ID or live inference was verified today.
- A real signed-in Codex planning call produced a valid two-stage plan for the small prepared UI pilot. The first app-sandboxed attempt could not initialize the CLI state database; the normal Mac-access retry succeeded. The plan was awaiting approval at the time of this offline check; see the later live-probe entry above for its approved state.
- Real DeepSeek structured coding and the complete multi-stage pilot remain unverified. The timeline is an offline-capable display of durable events, not evidence that this live gate passed.

## 2026-10-20 — Mac overnight workflow

### Observed passes

- **Automated suite:** 37 tests passed. The existing single-assignment coordinator/adapters/terminal tests remain green. New tests cover sequential stages, checks blocking acceptance, five-attempt limits, bounded rescue, context limits, exact approval/versioning, stop/resume, provider recovery, budget expiry, duplicate locks, protected scope, stale hashes, interrupted edits and external workspace/HEAD changes.
- **Original fake demo:** completed its expected revision loop and accepted outcome.
- **Actual Mac sandbox:** a live probe confirmed that private canary reads, writes to source, and loopback network connections were denied, while artifact writes succeeded. A separate probe confirmed an unapproved tracked file returned `EPERM` while an approved source file remained readable. This probe also runs before every unattended job.
- **Actual Codex staged planner:** a signed-in CLI call produced a valid two-stage plan from synthetic public input with tool features disabled. Spark connectivity was not needed.
- **Detached process exercise:** fake providers with real worktrees/checks completed through background startup, status, cooperative stop, resume and final acceptance. Both stages used one local attempt.
- **Prepared web pilot:** pinned React/TypeScript/Vite/Playwright dependencies installed before execution; the baseline built. The four-stage scripted HTTP exercise produced real code, four checkpoint commits, seven successful check executions (one at each implementation stage and four during final verification), and desktop/mobile screenshots. A deliberately malformed first response consumed one attempt; the layout stage succeeded on its second attempt. Later stages used one attempt each; no rescue was needed. Invalid persisted data was also tested. Source checkout remained separate from the generated branch.
- **Restricted pilot rerun:** the same four stages and all required checks passed after enforcing denied reads for tracked files outside the approved source context.
- **Real Codex final evidence review:** an independent signed-in review accepted the scripted pilot's source, all four check reports and screenshots. An earlier probe omitted three reports and correctly received `revise`; supplying the complete evidence produced `accept`. This was a separate final review, not a real-model review of every scripted stage.
- **Repository skill:** the Skill Creator validator passed for `overnight-build`.

### Failures found and resolved during implementation

- TypeScript required Vite's CSS module declarations in the starter configuration.
- Normal multiprocess Chromium hit a Mac Mach-port sandbox restriction. Single-process Chromium then ran inside the same outer filesystem/network restrictions; the sandbox was not bypassed.
- Background startup needed an approval check and startup confirmation; a PID alone was insufficient.
- Interrupted checks must not be memoized as completed. They now rerun after resume, while recorded provider responses and accepted stages are reused.
- The automated approval review timed out on one combined setup command before execution. A smaller browser-install command succeeded.

### Not verified

- The existing Mac-to-DeepSeek API endpoint still refused connections on this date. No Spark runtime setting was changed.
- A real DeepSeek text handoff, structured code submission, and complete real Codex/DeepSeek multi-stage run remain pending reconnection.
- No eight-hour endurance run or real hardware power-loss experiment has been performed. Recovery tests simulate interrupted writes/logs and runner transitions.
- Codex review is evidence assessment, not independent execution or a full factual/accessibility/security certification. The separate real reviewer explicitly left a full accessibility audit and screen-reader behavior unverified.

The release gate in [OVERNIGHT.md](OVERNIGHT.md) remains open until the real multi-stage pilot passes. Scripted/fake outcomes must not be presented as DeepSeek-generated work. Job IDs, absolute worktree paths and full private logs are kept in local ignored storage rather than this public record.
