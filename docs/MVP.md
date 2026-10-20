# First live milestone: Codex → DeepSeek → Codex

This is the first real model handoff for Frontier Orchestrator. It is a terminal-based project-design task. The coding workflow and browser interface follow after this loop works.

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

The Mac-to-Spark connection may be unavailable independently of app code. Build against fake adapters while it is down; the live demo requires the head's API to become reachable.

## Completion criteria

- One accepted plan is used for the assignment, DeepSeek response, and Codex review.
- The user can see which model contributed each part and what Codex actually reviewed.
- A revision is focused and bounded to one additional DeepSeek attempt; there is no open-ended loop.
- Accepted, needs-review, blocked, and failed outcomes are distinguishable. An unavailable model retains earlier job events and gives a useful error.
- Another developer can run the fake demo without this particular hardware or any copied credentials.

## Next milestones

- **Coding workflow:** use a disposable Git repo on the Mac; give DeepSeek only permitted file context and tools, collect a diff and check output, and have Codex review that evidence.
- **Local browser interface:** show plan, handoffs, artifacts, checks, history, and user controls after the real terminal loop is reliable.
- **Later:** provider choices, parallel work, and more general tasks. Keep the coordinator's plan and permission rules authoritative as capabilities grow.

## Codex integration reference

OpenAI's [Codex non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode) describes `codex exec`, structured output, read-only execution, and reuse of saved CLI authentication. Every user must authenticate through a supported flow on their own machine; never copy authentication files into this repository.
