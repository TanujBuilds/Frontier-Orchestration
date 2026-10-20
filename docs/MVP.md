# First MVP: frontier delegates a coding task to DeepSeek

This is a one-week target for a demonstrable vertical slice, not a commitment to a finished general-purpose coding agent.

## Demo story

1. The user selects a small disposable Git repository and describes one desired code change plus a check that should pass.
2. The frontier model proposes a short plan; the user accepts it.
3. The frontier model delegates one bounded step through the coordinator.
4. The local worker uses DeepSeek on the Sparks and the allowed workspace tools to investigate and implement the step.
5. The coordinator records the changed files, diff, check output, and any blocker.
6. The frontier model reviews this evidence, either accepts it or sends one focused correction back to the local worker.
7. The user sees the result, plan, handoffs, checks, and remaining uncertainties in one place.

## Components

| Component | First responsibility |
| --- | --- |
| Job store | Persist the goal, plan version, steps, events, artifacts, and final status locally. |
| Coordinator | Enforce the workflow, limits, and accepted plan; dispatch each model call. |
| Frontier adapter | Run the signed-in Codex CLI in a read-only sandbox to plan/delegate/review; consume structured output. |
| Local adapter | Send bounded requests to the DeepSeek API on AI Top 1; the service spans both Sparks. |
| Workspace runner | Read permitted files, apply permitted changes, and run the specified check in an isolated Mac workspace. |
| Interface | Start one job and inspect the plan, activity, diff, checks, and final result. |

## Build order

1. Define job, assignment, result, and event records; make a complete fake-model handoff run from a local command.
2. Add persistent task history and a clear stop after one review/revision cycle.
3. Connect the DeepSeek adapter when the Mac tunnel is reachable; verify basic response formatting before enabling tools.
4. Connect `codex exec` for structured planning and review. It reuses the local CLI login. Later, evaluate the Codex SDK or app-server if persistent sessions and streamed approvals improve the product.
5. Add a minimal local browser interface and run the demo on one disposable repository.
6. Document setup, permissions, observed limitations, and the demo for GitHub.

## Working week plan

| When | Target deliverable |
| --- | --- |
| Today | Project brief, accepted MVP scope, persistent coordinator with fake adapters, first local commit. |
| Next | Structured `codex exec` planner and reviewer in a read-only sandbox; verify a real turn under the user's existing login. |
| After that | Reconnect the Mac-to-AI-Top-1 tunnel, call DeepSeek, and measure whether it follows the assignment/result format. |
| Midweek | Scoped Mac workspace tools for one disposable coding repository; collect diff and check output. |
| Late week | Minimal browser view of plan, handoffs, results, and explicit approval. |
| End of week | Run one genuine frontier → DeepSeek → frontier review demo, document limits, and publish GitHub progress. |

The dates depend on actual Codex entitlement and DeepSeek reachability. The fake-adapter flow allows coordinator work to continue while either model is unavailable.

## Completion criteria

- One accepted plan survives the frontier-to-local-to-frontier handoff.
- The user can see which model did each step and what evidence the reviewer saw.
- The job ends in a clear accepted, needs-review, blocked, or failed state; no unbounded retries.
- A deliberately unavailable model gives a useful error and retains prior task state.
- Setup instructions let another developer run the fake-model demo without Tanuj's hardware or credentials.

## Deferred

Parallel workers, automatic model selection, remote shell execution on the Sparks, model installation, team accounts, billing, and long-term memory across unrelated projects.

## Frontier integration note

OpenAI's [Codex non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode) describes `codex exec`, JSONL output, output schemas, read-only sandboxing, and reuse of saved CLI authentication. The [Codex platform guidance](https://developers.openai.com/blog/codex-as-a-platform) distinguishes `codex exec` for bounded jobs from the SDK and app-server for longer-lived application flows. For this personal MVP, the CLI is the shortest path. A public release should never copy a developer's Codex authentication files into the repository; each user must authenticate through a supported flow on their own machine.
