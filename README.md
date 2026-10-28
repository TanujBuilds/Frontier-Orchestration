# Frontier Orchestrator

A frontier-reviewed application that lets a local model plan and do bounded work, while a frontier model independently judges the result. The application keeps one task record and plan so the user does not have to move context between models by hand. Coding jobs spend scarce frontier usage on passing-stage reviews by default, with optional explicit guidance before a stage starts.

## First live milestone

Give the application a substantial project-design brief from the Mac terminal. Codex plans and delegates one focused assignment. DeepSeek, served as one distributed model across two Sparks, answers it. Codex reviews the answer and may request one focused revision. The overnight coding workflow extends this loop to sequential implementation stages in an isolated Mac worktree. A read-only local browser timeline now displays saved jobs; browser controls remain later work.

For the first personal build, the frontier adapter uses a locally signed-in Codex CLI. The local adapter calls an already-running DeepSeek endpoint. The coordinator and task log preserve one accepted plan and bounded attempts. Model output does not directly authorize a file write or shell command.

## Overnight coding workflow

Ask from a Codex CLI or OpenCode session in this repository: **“Use overnight-build to build this feature in [project].”** DeepSeek drafts the stages for your approval and implements them; the coordinator runs the approved checks; Codex automatically reviews only stages whose checks pass. You can explicitly request one Codex hint before a stage starts. Five DeepSeek attempts and two Codex review calls per stage, an eight-hour deadline, durable resume, extra-attempt recovery, and a morning report are included.

See [the Mac setup and command guide](docs/OVERNIGHT.md) and [dated verification results](docs/VERIFICATION.md). To prepare the disposable React/TypeScript pilot:

```sh
npm run pilot -- /path/to/new-disposable-pilot
```

Once an approved project job starts, `npm run --silent project -- watch --job JOB_ID` shows its saved Codex → DeepSeek → Codex handoffs live. Add `--once` to replay and exit, or `--full` to inspect exact private event payloads.

To see the same handoffs in a browser, run this in **Mac Terminal**:

```sh
npm run dashboard -- --job JOB_ID
```

Open the loopback URL printed by the command. The page updates from the local JSONL job log every two seconds and shows stage status, model handoffs, checks, recorded screenshots, and expandable private payloads. It is read-only and listens only on 127.0.0.1. Closing the browser does not stop a background job; stop the viewer with Ctrl-C in its Terminal. Use `--port 0` if the default port is already occupied.

## Run the first live terminal workflow

Run these commands in **Mac Terminal** from this repository. The brief is sent to the signed-in Codex CLI for planning and review. The focused assignment and any revision go to the configured DeepSeek API; no model is given an app tool for editing files or running commands.

```sh
codex login status
export DEEPSEEK_BASE_URL='http://localhost:<forwarded-port>/v1'
npm run live -- --brief examples/design-brief.md
```

Replace `<forwarded-port>` with the port of an existing Mac-to-head-Spark forward. Set `DEEPSEEK_MODEL_ID` only if `/v1/models` advertises more than one model or you want to pin a specific advertised ID. `FRONTIER_MODEL_ID` optionally selects an available Codex CLI model; otherwise the signed-in CLI default is used. The application checks `/v1/models` after plan approval. It does not start or configure the Spark service or tunnel.

If you need a forward, establish it in another **Mac Terminal** session using your own head host and API port, then check the model list before running the job:

```sh
ssh -N -L <forwarded-port>:127.0.0.1:<api-port> <head-ssh-host>
curl "$DEEPSEEK_BASE_URL/models"
```

The terminal displays the full plan and requires `y` before dispatch. It then displays every answer and review, final status, job ID, and path to the ignored JSONL log under `.data/jobs/`. Rejection or EOF pauses the job. Exit codes are `0` accepted, `2` paused/blocked/needs-review, and `1` failed. Provider failures retain prior events; rerunning starts a new job. Briefs and answers remain in the local log, so use a brief you are willing to send to Codex and keep that ignored directory private.

The local endpoint is optional for an offline exercise:

```sh
npm run live -- --brief examples/design-brief.md --fake
```

This exercises the same terminal approval and log path with fake model responses. `npm test` checks the coordinator, both adapters with mock responses, and the fake terminal flow.

## Run the original fake coordinator demo

Node.js 24 is installed on the development Mac. The initial coordinator uses only Node's built-in modules and fake model adapters, so it can run without credentials or the Sparks:

```sh
npm run demo -- "Fix a small bug and explain the change"
```

This writes an event log under `.data/jobs/` and prints the frontier → local → frontier → local → frontier handoff. Every model response in this command is fake; it is a coordinator demonstration.

See [docs/PRODUCT_CONTEXT.md](docs/PRODUCT_CONTEXT.md) for the product background and [docs/MVP.md](docs/MVP.md) for the first live milestone.

## License

MIT. See [LICENSE](LICENSE).

## Status (2026-10-22)

The signed-in Codex CLI, overnight coordinator, protected Mac worktree, detached runner, skill, terminal timeline, and read-only browser timeline are implemented. DeepSeek plans and implements coding jobs, checks gate every automatic Codex review call, and no Codex rescue exists. An explicit command can request one Codex hint before a stage starts. On October 21 the real text handoff completed with two DeepSeek answers and two Codex reviews; its final status was `needs_review` after the one-revision limit. The real two-stage coding pilot then finished `accepted`: DeepSeek built and revised a responsive UI shell, protected layout checks passed, Codex reviewed the recorded diffs and screenshots, and both stages were committed in an isolated worktree. This narrow pilot does not cover interactions, persistence, or the full four-stage Night Shift release gate. See [verification details](docs/VERIFICATION.md).

On October 22 a new two-stage live pilot exercised the DeepSeek-planned, review-only workflow. Both stages were accepted after passing the protected layout check, with exactly two Codex review calls and no Codex planning or guidance call. The generated mobile layout still has excessive space in the form; the full Night Shift feature gate remains open.

## Approved coding backlog

The [task-queue workflow](docs/TASK_QUEUE.md) runs fresh approved coding jobs sequentially with persistent priorities, aggregate budgets, stop and crash recovery. Invoke the repository skill at `.agents/skills/task-queue/SKILL.md`, or run `npm run queue -- help`.
