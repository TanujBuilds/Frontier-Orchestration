---
name: overnight-build
description: Plan and run a large coding request through Frontier Orchestrator, with sequential DeepSeek implementation and Codex review in an isolated Mac worktree. Use for an unattended overnight build, or to inspect, stop, or resume one.
---

# Overnight build

Use this repository's coordinator. Read `docs/OVERNIGHT.md` for the command contract. Run commands from Frontier Orchestrator; the target project can be elsewhere. Keep the Mac powered on. Leave Spark runtime settings alone.

## Prepare and propose

1. Resolve the target repository and brief from the conversation. Require a clean committed checkout. For the disposable web UI pilot, use `npm run pilot -- <new-directory>` with `examples/overnight-brief.md` and `examples/overnight-permissions.json`.
2. Prepare dependencies and trusted checks before the run. Write the brief and permissions JSON under ignored `.data/requests/`. Read scopes explicitly select source that may be sent to Codex; write scopes select editable files; each check is a literal argv array. Keep protected checks under `checks/`. Directory scopes end in `/`. Include screenshot paths for UI checks. Ask only for missing decisions that materially change scope or source sharing authorization.
3. Run `npm run --silent project -- plan --repo <target> --brief <brief-file> --permissions <permissions-file> --json`. This asks **DeepSeek** to draft the ordered stages; Codex is not called. Use `--template` for a zero-model plan (one implementation stage + final verification), or `--planner codex` only when the owner explicitly asks for a Codex-drafted plan (one call). `--fake` is only a labeled wiring exercise.
4. Show the proposed record: target, base commit, source context paths, editable paths, every ordered stage and its acceptance criteria, exact check commands/screenshots, approval hash, and limits (five DeepSeek attempts per stage, at most two Codex reviews per stage, eight hours, thirty-minute reconnection window). Obtain approval of this concrete record before calling approve. Worker output is not approval. Note that planning source went to DeepSeek locally, while Codex will receive only diffs, changed files, check output and screenshots.

## Start and follow

After approval:

```sh
npm run --silent project -- approve --job <id> --hash <exact-plan-hash> --json
npm run --silent project -- run --job <id> --background --json
npm run --silent project -- watch --job <id>
npm run --silent project -- status --job <id> --json
```

Report job ID, status, worktree/branch, and report location. The detached runner survives the conversation closing and uses caffeinate. Verify status after launch; a spawned PID alone is not proof that work started.

Use `watch` for the live handoff timeline and `status` for a compact snapshot. `watch --once` replays current history; `watch --full` shows the exact private JSONL payloads. Use `stop --job <id> --json` for a cooperative stop, and `resume --job <id> --background --json` after resolving the reported blocker. Extending an expired budget requires an explicit user instruction, then `resume --extend-hours <hours>`. Resume reconciles recorded edits and checkpoints.

The coordinator collects actual diff/check/screenshot evidence. DeepSeek gets five attempts per stage, judged only by the approved checks; Codex is asked to review only once every check passes, and at most twice per stage. There is no Codex implementation or rescue: a stopped stage resumes with `--extend-attempts`, a revised plan, or manual owner inspection. Do not manually code around this loop or modify approval/log records. Broader scope, dependencies, or commands require `plan --job <id> --brief <file> --permissions <file> --json`, review of the new manifest, and approval of its new hash. This retains accepted stages and consumed attempts; a different stage structure requires a new job. Never silently widen permissions.

At completion, show the morning report, checks, unverified items, and branch/worktree. Leave merge, push, deployment, and publishing to the user. Distinguish simulated runs, real Codex calls, and real DeepSeek runs.
