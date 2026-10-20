# Verification record

## 2026-10-20 — Mac overnight workflow

### Observed passes

- **Automated suite:** 37 tests passed. The existing single-assignment coordinator/adapters/terminal tests remain green. New tests cover sequential stages, checks blocking acceptance, five-attempt limits, bounded rescue, context limits, exact approval/versioning, stop/resume, provider recovery, budget expiry, duplicate locks, protected scope, stale hashes, interrupted edits and external workspace/HEAD changes.
- **Original fake demo:** completed its expected revision loop and accepted outcome.
- **Actual Mac sandbox:** a live probe confirmed that private canary reads, writes to source, and loopback network connections were denied, while artifact writes succeeded. This probe also runs before every unattended job.
- **Actual Codex staged planner:** a signed-in CLI call produced a valid two-stage plan from synthetic public input with tool features disabled. Spark connectivity was not needed.
- **Detached process exercise:** fake providers with real worktrees/checks completed through background startup, status, cooperative stop, resume and final acceptance. Both stages used one local attempt.
- **Prepared web pilot:** pinned React/TypeScript/Vite/Playwright dependencies installed before execution; the baseline built. The four-stage scripted HTTP exercise produced real code, four checkpoint commits, seven successful check executions (one at each implementation stage and four during final verification), and desktop/mobile screenshots. A deliberately malformed first response consumed one attempt; the layout stage succeeded on its second attempt. Later stages used one attempt each; no rescue was needed. Invalid persisted data was also tested. Source checkout remained separate from the generated branch.
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
