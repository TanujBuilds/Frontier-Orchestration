---
name: task-queue
description: Use when approved Frontier Orchestrator coding jobs need a prioritized backlog, unattended sequential execution, queue status, or recovery after interruption. For preparing a single coding plan use overnight-build; research and Spark-only execution are outside this queue.
---

# Task queue

Use the existing Frontier Orchestrator coordinator. This queue selects work; the coordinator retains authority over approvals, file scopes, checks, attempts, deadlines and independent Codex review.

## Configure and enqueue

Resolve `FRONTIER_ORCHESTRATOR_ROOT` to the installed checkout containing `src/task-queue-cli.mjs`. Set `QUEUE_DATA_DIR` to the coordinator data directory containing the intended jobs, usually that checkout's ignored `.data`. Use the owner's existing private DeepSeek configuration and signed-in Codex CLI for live execution. Never copy credentials or private addresses into tracked files.

Read CLI help for options:

```sh
node "$FRONTIER_ORCHESTRATOR_ROOT/src/task-queue-cli.mjs" help
node "$FRONTIER_ORCHESTRATOR_ROOT/src/task-queue-cli.mjs" init --data-dir "$QUEUE_DATA_DIR" --json
node "$FRONTIER_ORCHESTRATOR_ROOT/src/task-queue-cli.mjs" add --data-dir "$QUEUE_DATA_DIR" --job JOB_ID --hash EXACT_PLAN_HASH --priority 10 --json
```

Select only jobs authorized for this run. Inspect their exact manifest/hash and existing approval; enqueue never supplies missing approval. Prepare new plans through overnight-build when needed. Higher priority runs first, with FIFO ties. Repeated add is idempotent. A changed plan blocks dispatch until the updated concrete scope is authorized; model output cannot approve it.

## Run and inspect

```sh
node "$FRONTIER_ORCHESTRATOR_ROOT/src/task-queue-cli.mjs" run --data-dir "$QUEUE_DATA_DIR" --background --json
node "$FRONTIER_ORCHESTRATOR_ROOT/src/task-queue-cli.mjs" status --data-dir "$QUEUE_DATA_DIR" --json
```

Verify a recorded worker start and subsequent job activity, not just a PID. Default execution waits for newly enqueued jobs within its budget; `--once` drains available work and exits. One queue worker runs one job at a time. Separately launched workers share model capacity and are not coordinated by this queue.

Defaults are eight hours, ten distinct jobs and eight review-call reservations across the queue. Restart preserves limits and spent reservations, including failed calls. Review is still check-gated. There are no queue planning, rescue or guidance calls. A failed or blocked job remains visible while other eligible jobs proceed.

## Stop and recover

Use `stop` to abort current work cooperatively and prevent the next dispatch. Use `cancel --job JOB_ID` for pending work. After a crashed process, run the same queue again: saved job operations and budgets are retained. A live worker or uncertain lock requires inspection rather than takeover.

Stopped/failed jobs require an explicit `retry --job JOB_ID --hash EXACT_PLAN_HASH` within existing authorization. Retry does not extend job limits, refresh approvals, or reset counters; at most one manual retry is available per item. Scope changes or exhausted limits belong to the coordinator's explicit recovery workflow. Never edit journals or create replacement queues to bypass limits.

Report queue status, each job outcome, reasons needing attention, review reservations, and result/report paths. Label `init --fake` exercises as simulations and keep them in a separate data directory.

The detached scheduler survives chat closure on a powered-on Mac and keeps it awake. It does not survive shutdown or move coding/check execution to a Spark. Leave Spark runtime settings unchanged. Leave merge, push and publication to the user.
