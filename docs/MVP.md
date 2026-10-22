# First live milestone: Codex → DeepSeek → Codex

This is the first real model handoff for Frontier Orchestrator. It is a terminal-based project-design task. The coding workflow and a read-only browser timeline have been built around it; the complete live model loop remains the verification gate.

## Demo story

1. On the Mac, the user gives the application a substantial project-design brief.
2. Codex proposes one focused assignment and a short plan. The user accepts the plan before dispatch.
3. The coordinator sends the accepted assignment to the already-running DeepSeek API and records its answer.
4. Codex reviews the answer against the goal and plan. It accepts, reports a blocker, or requests one focused revision from DeepSeek.
5. The terminal shows the plan, answer, review, final status, and job ID. The local event log keeps the same handoffs.

No file editing, shell execution by DeepSeek, or browser interface is required for this first live milestone. “Reviewed” means Codex assessed the answer against the brief; it does not imply independent factual verification of every claim.

## Existing foundation

The repository already contains a Node.js coordinator, fake frontier/local adapters, and an append-only JSONL job log. The fake demo exercises plan, approval, assignment, review, one revision, and completion without calling a model. Preserve that offline path so contributors without the hardware can inspect the workflow.

## Build order

1. Add a Mac terminal entry point that accepts a brief from a file, prints the proposed plan, and asks the user to accept it. Keep one assignment and at most two local attempts.
2. Add a Codex CLI adapter for planning and review. Use the user's local login, read-only execution, and structured output; report a clear failure if a live call cannot complete.
3. Add a DeepSeek HTTP adapter for the configured OpenAI-compatible endpoint. Confirm the model ID and basic response shape before relying on the answer format. Store the full returned answer as a job result.
4. Preserve the accepted plan and all model outcomes in the existing event log. If a provider is unavailable, stop clearly without losing prior events.
5. Add a sample design brief and Mac setup instructions. Demonstrate the real handoff and record observed limits in the repository.

The Mac-to-Spark connection may be unavailable independently of app code. Build against fake adapters while it is down; the live demo requires the head's API to become reachable. On 2026-10-20, the signed-in Codex adapter completed separate real planning and review calls. A real terminal run recorded plan approval and a clear DeepSeek connection failure. A separate end-to-end run used real Codex planning/review with a temporary local HTTP stub and recorded the answer, review, and `blocked` status. The Mac's local DeepSeek forward still refused connections, so the complete live handoff with the Spark model remains unverified.

## Completion criteria

- One accepted plan is used for the assignment, DeepSeek response, and Codex review.
- The user can see which model contributed each part and what Codex actually reviewed.
- A revision is focused and bounded to one additional DeepSeek attempt; there is no open-ended loop.
- Accepted, needs-review, blocked, and failed outcomes are distinguishable. An unavailable model retains earlier job events and gives a useful error.
- Another developer can run the fake demo without this particular hardware or any copied credentials.

## Next milestones

- **Overnight coding workflow (review-only frontier, 2026-10-21):** sequential stages in an isolated Mac Git worktree, structured bounded edits, sandboxed checks, and Codex review only after checks pass. DeepSeek drafts the plan and does all implementation; no Codex planning or rescue. Implementation and recovery details are in [OVERNIGHT.md](OVERNIGHT.md); the real multi-stage release gate remains pending Spark reconnection.
- **Local browser interface:** the read-only timeline already shows saved handoffs, checks, screenshots, and history. User controls follow after the real terminal loop is reliable.
- **Later:** provider choices, parallel work, and more general tasks. Keep the coordinator's plan and permission rules authoritative as capabilities grow.

## Codex integration reference

OpenAI's [Codex non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode) describes `codex exec`, structured output, read-only execution, and reuse of saved CLI authentication. Every user must authenticate through a supported flow on their own machine; never copy authentication files into this repository.
