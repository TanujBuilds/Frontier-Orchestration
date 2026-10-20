# Overnight coding on the Mac

## What this adds

A large request becomes one approved, ordered plan. Codex prepares each assignment and reviews actual changes. DeepSeek does the implementation through the existing single service across both Sparks. The Node coordinator owns permissions, edits, checks, attempts, deadlines, checkpoint commits and the event history.

The original `npm run demo` and `npm run live -- --brief <file>` commands remain available.

```mermaid
flowchart TD
    Brief["Brief + chosen source context"] --> Plan["Codex proposes 1–10 stages"]
    Plan --> Approval["User approves exact plan and permissions"]
    Approval --> Workspace["Isolated Mac worktree"]
    Workspace --> Assign["Codex prepares current assignment"]
    Assign --> Worker["DeepSeek requests files, then submits edits"]
    Worker --> Validate["Validate paths and hashes; record edit intent"]
    Validate --> Checks["Apply edits; run approved sandboxed checks"]
    Checks --> Review["Codex reviews diff, check evidence and screenshots"]
    Review -->|"Accepted and checks pass"| Commit["Local checkpoint commit"]
    Commit -->|"Next stage"| Assign
    Commit -->|"All stages accepted"| Report["Morning report + reviewable branch"]
    Review -->|"Repair; fewer than 5 local attempts"| Worker
    Review -->|"5 local attempts exhausted"| Rescue["One Codex repair; max 2 per job"]
    Rescue --> Checks
```

A failed required check cannot be overridden by a model. A failed rescue stops that stage. Every new stage starts with DeepSeek again. There is no merge, push, deployment or Spark configuration change.

## Start inside Codex CLI

Open Codex CLI in this repository and say:

> Use overnight-build to build this feature in [target repository]: [your large request].

The repository skill is in `.agents/skills/overnight-build/SKILL.md`. Repository discovery follows the [official skill documentation](https://learn.chatgpt.com/docs/build-skills). The skill resolves the target, prepares the brief/permissions, shows the proposed stages and asks for approval of that concrete record. It then launches the runner and reports its job ID.

Before planning, select which source may be shared with the signed-in Codex service. Planning itself sends the selected source; approval of the implementation plan comes afterward. Secrets and coordinator metadata are excluded, but source selection is still the user's decision.

## Prepare the disposable UI pilot

On the Mac, from the Orchestrator checkout:

```sh
npm run pilot -- /path/to/new-disposable-pilot
```

The destination must not exist. Preparation copies the React/TypeScript starter, installs pinned dependencies with `npm ci`, downloads Chromium into local `node_modules`, verifies the baseline builds, and commits the starter and protected checks. This is the only dependency-install phase. Node 24 is the tested runtime for this pilot. It requires a working package registry/download connection during preparation.

The requested app is **Night Shift**, a task board. `examples/overnight-brief.md` specifies three implementation stages (layout, interactions, persistence/accessibility) and final integration verification. `examples/overnight-permissions.json` permits `src/` edits and declares four protected checks. The starter intentionally does not pass the feature checks.

The checks build the app, run Chromium, test behavior, and capture desktop/mobile PNGs. Browser requests are fulfilled from local build files through [Playwright routing](https://playwright.dev/docs/api/class-page#page-route); no localhost server or network grant is needed. Chromium uses a single process under the outer Codex Mac sandbox. Baseline accessibility checks cover labels, landmarks, keyboard interaction and a live region; they are not a full accessibility audit.

## Command contract

Use `node src/project-cli.mjs ...` or `npm run --silent project -- ...`. `--json` produces structured output. Paths and IDs below are placeholders.

```sh
npm run --silent project -- plan --repo /path/to/project \
  --brief examples/overnight-brief.md --permissions examples/overnight-permissions.json --json

# After reviewing and approving the returned manifest:
npm run --silent project -- approve --job JOB_ID --hash PLAN_HASH --json
npm run --silent project -- run --job JOB_ID --background --json
npm run --silent project -- status --job JOB_ID --json
npm run --silent project -- stop --job JOB_ID --json
npm run --silent project -- resume --job JOB_ID --background --json

# Only after explicitly authorizing additional time:
npm run --silent project -- resume --job JOB_ID --extend-hours 2 --background --json
```

`plan` accepts `--hours` (default 8, up to 24) and `--fake`. `--data-dir` selects local job storage; use the same location on later commands. `run` without `--background` stays in the foreground. Exit codes: 0 for successful commands/accepted jobs, 2 for paused/blocked/needs_review/interrupted jobs, 1 for failures. A background launch confirms startup, not eventual success; use status/report for the outcome.

Replanning a paused job:

```sh
npm run --silent project -- plan --job JOB_ID --brief revised-brief.md \
  --permissions revised-permissions.json --json
npm run --silent project -- approve --job JOB_ID --hash NEW_PLAN_HASH --json
npm run --silent project -- resume --job JOB_ID --background --json
```

This appends a new plan version. Existing stage IDs/order and accepted stages are preserved, consumed attempts/rescues remain consumed, and unfinished assignments are regenerated. A different stage structure needs a new job. Broader permissions never take effect without the new hash approval. Prepare newly authorized dependencies before resuming; existing worktrees do not automatically install or refresh packages.

## Providers and process lifetime

- Authenticate Codex CLI on the Mac. Planning, assignments, reviews and rescue use ephemeral structured `codex exec` calls. Tool features are disabled for these model calls; model output is interpreted only by the coordinator. Authentication stays in the existing CLI login.
- Set `DEEPSEEK_BASE_URL` to the existing OpenAI-compatible API including `/v1`. Optionally set `DEEPSEEK_MODEL_ID`; without it exactly one model must be advertised. Set `FRONTIER_MODEL_ID` only if you want an explicit Codex model. Keep these settings in the environment, outside tracked files.
- The detached process inherits those settings, redirects output to its local `runner.log`, holds a job lock and uses `caffeinate`. Closing the conversation does not stop it. Power loss, reboot, suspension and account limits can still interrupt it.
- A transient provider error waits with bounded backoff, up to 30 minutes. Waiting does not consume extra attempts or trigger rescue. Authentication/configuration/scope errors pause immediately. Per-call timeouts remain finite (Codex 5 minutes, DeepSeek 10 minutes).
- The eight-hour deadline is wall clock time from the first run, including provider waits and downtime. Restarts do not reset it. Resume after expiration requires an explicit extension.

## Files, execution and recovery

The initial target must be a clean Git repository. The branch is `codex/overnight-<job-id>` from the selected committed revision. The worktree lives in ignored `.data/artifacts/<job-id>/worktree`. Accepted stages become local commits; unfinished edits are retained for inspection. The source checkout stays separate.

The structured worker protocol permits up to ten file-request exchanges followed by one edit batch per attempt. A batch contains at most 30 UTF-8 writes/deletions, with expected SHA-256 hashes (null means the file must not exist). Files are capped at 128 KiB and combined context/diff is bounded. Stale hashes or malformed submissions consume an attempt and generate repair feedback. Path traversal, symlinks, protected files and scope expansion pause the job. Dependency manifests, Git metadata, secrets, instructions, checks and coordinator state cannot be worker-edited.

Only approved literal command arrays run. The installed Codex Mac sandbox grants read access to the worktree and system runtime files, write access only to `dist/` and `.overnight-output/`, and denies network access. A startup probe verifies private reads/source writes/network connections are denied and artifact writes work. An unavailable sandbox blocks the run. Checks that require another writable output directory are not supported by this first version.

The log at `.data/jobs/<job-id>.jsonl` records exact model inputs/results, plan versions/approval, attempts, intent before edits, applied hashes, full command output, reviews, checkpoint commits and provider usage when supplied. Artifacts and `report.md` live alongside the worktree. These are private local records, not public documentation.

On resume, recorded responses and checks are reused and accepted stages are skipped. Interrupted edit batches reconcile each file against its before/after hash before completing the transaction. External source/HEAD changes pause for inspection. A response lost before it was durably recorded may need another provider call; no exactly-once network-delivery claim is made. A partial final JSONL fragment is preserved separately before locked recovery. A malformed lock or conflicting workspace requires inspection rather than automatic overwriting.

## Verification and release gate

`npm test` uses fake providers and injected checks for deterministic coordinator tests. The checks cover stage ordering, approval binding/versioning, failed checks, attempt/rescue limits, context limits, provider recovery, auth pauses, deadlines, stop/resume, stale edits, protected scope, interrupted batches, external changes and duplicate locks.

After preparing a disposable pilot, run the offline integration exercise:

```sh
node scripts/verify-pilot.mjs /path/to/prepared-disposable-pilot
```

This uses a local HTTP stub with scripted responses and scripted frontier review, including a deliberately malformed first response. It performs real worktree edits, sandboxed builds/browser checks, screenshots and checkpoint commits. Its report is explicitly labeled **scripted**. It does not measure DeepSeek quality or replace the live release gate.

The live release gate remains: reconnect the existing service; verify `/v1/models`; verify the original text handoff; verify a structured coding response; run the staged pilot with real Codex and DeepSeek; inspect every accepted checkpoint, screenshot/check result and final report. Record observed results without credentials or machine-specific connection details. See `VERIFICATION.md` for dated observations.
