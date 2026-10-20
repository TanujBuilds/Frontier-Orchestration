# Frontier Orchestrator

A local-first application that lets a frontier model delegate bounded work to a local model, inspect the result, and request focused revisions. The application keeps one task record and plan so the user does not have to move context between models by hand.

## First demo

Give the application a small coding task in a disposable Git repository on the Mac. A frontier model plans and delegates one implementation step. DeepSeek, served across AI Top 1 and AI Top 2, works on that step. The application records the proposed changes and check results. The frontier model reviews the evidence, then accepts the result or requests one local revision.

For the first personal build, the frontier adapter will use a locally signed-in Codex CLI. The local adapter will call an already-running DeepSeek endpoint. The coordinator, model adapters, workspace tools, and task log are separate components. Model output does not directly authorize a file write or shell command; the coordinator applies the job's permissions and limits.

## Run the first milestone

Node.js 24 is installed on the development Mac. The initial coordinator uses only Node's built-in modules and fake model adapters, so it can run without credentials or the Sparks:

```sh
npm run demo -- "Fix a small bug and explain the change"
```

This writes an event log under `.data/jobs/` and prints the frontier → local → frontier → local → frontier handoff. Every model response in this command is fake; it is a coordinator demonstration.

See [docs/MVP.md](docs/MVP.md) for the first build plan and current decisions.

## License

MIT. See [LICENSE](LICENSE).

## Status

Planning and initial implementation. The local Codex CLI is installed and reports a ChatGPT login, but a live Codex inference call has not yet been verified for this app. The last local check could not reach the DeepSeek API tunnel on the Mac, so live local integration remains to be verified.
