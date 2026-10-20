# Frontier Orchestrator

A local-first application that lets a frontier model delegate bounded work to a local model, inspect the result, and request focused revisions. The application keeps one task record and plan so the user does not have to move context between models by hand.

## First live milestone

Give the application a substantial project-design brief from the Mac terminal. Codex plans and delegates one focused assignment. DeepSeek, served as one distributed model across two Sparks, answers it. Codex reviews the answer and may request one focused revision. Code editing in a disposable Git repository and a local browser interface are later milestones.

For the first personal build, the frontier adapter will use a locally signed-in Codex CLI. The local adapter will call an already-running DeepSeek endpoint. The coordinator and task log preserve one accepted plan and bounded attempts. Model output does not directly authorize a file write or shell command.

## Run the current fake coordinator demo

Node.js 24 is installed on the development Mac. The initial coordinator uses only Node's built-in modules and fake model adapters, so it can run without credentials or the Sparks:

```sh
npm run demo -- "Fix a small bug and explain the change"
```

This writes an event log under `.data/jobs/` and prints the frontier → local → frontier → local → frontier handoff. Every model response in this command is fake; it is a coordinator demonstration.

See [docs/PRODUCT_CONTEXT.md](docs/PRODUCT_CONTEXT.md) for the product background and [docs/MVP.md](docs/MVP.md) for the first live milestone.

## License

MIT. See [LICENSE](LICENSE).

## Status

Planning and initial implementation. The local Codex CLI reports a ChatGPT login, but a live Codex inference call has not yet been verified for this app. The most recent Mac check could not reach the DeepSeek API tunnel, so live local integration remains to be verified. The command above uses fake model responses only.
