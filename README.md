# Frontier Orchestrator

A frontier-led application that lets a frontier model delegate bounded work to a local model, inspect the result, and request focused revisions. The application keeps one task record and plan so the user does not have to move context between models by hand.

## First live milestone

Give the application a substantial project-design brief from the Mac terminal. Codex plans and delegates one focused assignment. DeepSeek, served as one distributed model across two Sparks, answers it. Codex reviews the answer and may request one focused revision. Code editing in a disposable Git repository and a local browser interface are later milestones.

For the first personal build, the frontier adapter will use a locally signed-in Codex CLI. The local adapter will call an already-running DeepSeek endpoint. The coordinator and task log preserve one accepted plan and bounded attempts. Model output does not directly authorize a file write or shell command.

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

## Status (2026-10-20)

The signed-in Codex CLI completed separate live planning and review probes through the new adapter. The latest Mac check could not reach the DeepSeek API tunnel, so the full handoff still needs a live integration run when the head service is reachable. The original `npm run demo` command uses fake responses only.
