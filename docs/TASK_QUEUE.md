# Task queue

The `task-queue` skill runs a persistent priority backlog of already approved coding jobs. It reuses the overnight coordinator for DeepSeek implementation, sandboxed checks, checkpoints and independent Codex review. There are no queue planning or rescue calls.

## Use

Run commands from this checkout. `DATA` is the private coordinator data directory containing the intended jobs and artifacts. Live execution uses the existing `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL_ID`, optional `FRONTIER_MODEL_ID`, and signed-in Codex CLI on `PATH`.

```sh
node src/task-queue-cli.mjs init --data-dir "$DATA" --json
node src/task-queue-cli.mjs add --data-dir "$DATA" --job JOB_ID --hash EXACT_PLAN_HASH --priority 10 --json
node src/task-queue-cli.mjs run --data-dir "$DATA" --background --json
node src/task-queue-cli.mjs status --data-dir "$DATA" --json
node src/task-queue-cli.mjs stop --data-dir "$DATA" --json
```

Use `help` for every command and option. Higher priorities run first, with FIFO ties. Only fresh, approved jobs can enter; enqueue does not approve or change a job. Duplicate enqueue with the same hash is idempotent. Changed approvals invalidate the queued item. The queued hash and job eligibility are checked again inside the project lock.

Default execution watches for new work. `run --once` drains currently eligible work and exits; it can also run in the background. A detached launch is confirmed using that child worker's durable token and PID, including when a short run has already finished. It does not infer startup from historical work.

## Limits and recovery

Initialization fixes the queue's limits: eight hours, ten distinct jobs and eight review-call reservations by default. The queue deadline starts with its first worker. Repeated initialization and restarts preserve the original limits, deadline and consumed budgets. This version has no automatic budget renewal or boot scheduler.

A single queue worker executes one job at a time. Queue state and worker ownership live in an append-only journal below `DATA/task-queue/`; short coordinator journal locks serialize mutations while allowing enqueue and stop during model calls. Only verified dead owners permit lock recovery. Malformed or uncertain ownership requires inspection.

Stop and the queue deadline abort active work and prevent another dispatch. Restart clears the queue stop flag while retaining budgets. An interrupted job stopped by the user stays paused. A crashed worker's unfinished job is recovered from saved coordinator operations; completed results are reconciled without executing them again. Recovery and retry do not spend an additional distinct-job slot.

Failed or blocked jobs remain visible while unrelated eligible jobs continue. `retry --job JOB_ID --hash EXACT_PLAN_HASH` allows one explicit manual retry per item. It uses coordinator resume without extending attempts, reviews, scope or deadlines. Scope changes and exhausted job limits require the coordinator's explicit recovery workflow. An invalidated item is not silently rebound to a new plan.

Review permits and project-stage call intents are journaled before the actual frontier call, and failed or interrupted calls retain their reservations. Denied permits do not consume a project review round. Provider calls still happen only after the job's required checks pass. Once the queue review budget is exhausted, pending jobs remain queued.

`status` provides queue and item outcomes, reasons needing attention, remaining budgets, the event log and a JSON report. The report is a snapshot of the included event sequence; the journal is authoritative.

## Verification and boundaries

`init --fake` creates a separate scripted queue. Fake jobs cannot enter a live queue, and live jobs cannot enter a fake queue. Wrong-action flags are rejected; `run --fake` cannot silently dispatch live work.

Run `npm test` for coordinator, queue, authorization, CLI, crash and deadline regressions. Real provider validation is separate from scripted tests. A small successful marker job demonstrates the handoff; it does not establish performance or quality on large coding projects.

The scheduler and checks run on the Mac. Background execution keeps it awake and survives chat closure; shutdown still stops it. Separately launched delegation workers share model capacity and are not scheduled by this queue. Spark runtime settings, merge, push and publication remain outside this skill.
