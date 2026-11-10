# Mosaic execution recovery

An Overnight v2 restart uses the existing state root. The coordinator's saved
approval hash, graph, deadlines, spending and candidate worktrees determine
what may continue. A replacement process proves ownership through the
coordinator lease. Elapsed time alone does not prove a worker has exited.

## Where progress is recorded

| Boundary | Durable evidence | Recovery contract |
| --- | --- | --- |
| Model dispatch | SQLite reserves a request key before inference and counts it against the original limit | A saved reservation without a terminal outcome is held as uncertain and spent |
| Model response | SQLite stores the result under the original request ID | Resume the stage with the saved response |
| Edit batch | The workspace journal records edit intent and completion, keyed by the approved attempt and batch | Recover the journal and reuse the receipt for the same batch |
| Protected checks | The workspace journal records the check operation and its completed result | A saved completed result can be replayed. A missing result leaves check-process quiescence unverified |
| Failed-check repair | The checkpoint binds the failed gate to its snapshot, permissions and journal receipt | A quiescent saved repair boundary can resume with its original feedback and counters; missing or changed receipts and unapplied edits prevent automatic continuation |
| Review | The coordinator records a separate review reservation and verdict | A missing verdict stays spent and requires reconciliation. A saved passing review can proceed through integration |
| Integration | The goal holds the pending import identity and the integration journal binds the candidate and target commit | Continue or repair the same import under existing controls and protected checks |
| Report and alert | Saved coordinator state drives the JSON and Markdown report. Alert delivery is reserved before the OS call | Rebuild the report after an interrupted publication. An alert with an uncertain delivery receipt stays reserved |

The coordinator keeps workspace and journal evidence even when automatic
continuation is unsafe. A report can show the first blocker alongside the
current condition. An expired authorization still applies when its earlier
failure was an unknown provider response or a missing owner decision.

## Inspecting saved work

Start with the goal and stage status. Use `task_evidence` for a bounded view
of the saved candidate, checks, answers and feedback. The Overnight report is
saved as `overnight-reports/<goal-id>/report.json` and `report.md` under the
state root. The structured report preserves identifiers and deadlines for
correlating evidence across restarts.

- A known non-dispatch outage can wait for readiness within the original
  reconnect, task and goal limits. The original reservation stays spent.
- An unknown response needs trustworthy provider or backend evidence before
  the original request can be reconciled. Retain its ID and candidate files.
- A saved question identifies the stage awaiting `question_answer`. An
  authorized answer resumes the same task under its remaining limits.
- A pause or stop requires explicit `work_control` resume within the
  original authorization. Expiration requires a separately authorized window.
- A pending integration retains its import and candidate identities.
  Inspect the existing operation with `operation_get` and use its supported
  retry or the applicable `task_integration_repair` route.

## Isolated verification

Planner callbacks are fenced to the original lease generation, approved goal
and planning attempt. A replaced worker cannot save a late response, rewrite a
request outcome or materialize tasks. Responses saved while paused or stopped
remain available after an explicit resume without another planning request.
Initial model discovery and reconnect discovery both recheck controls,
deadlines and the approved worker binding immediately before completion dispatch.
A refused dispatch retains its spent reservation. Reconnect readiness never
extends the original reconnect window.

A pause or stop during the protected checks before frontier review preserves
the unspent review for resume. A caught reviewer failure retains the original
request identity so the report can identify an unknown outcome; recovery does
not silently issue another review.

Run from the repository checkout with Node 24 and the pinned dependencies.

```sh
node --test --test-concurrency=1 test/mosaic-recovery*.test.mjs test/harness-{crash,idle,integration,overnight-v2}.test.mjs
node --test --test-concurrency=1 test/mosaic-integration-*.test.mjs test/mosaic-flexibility-overnight.test.mjs
```

The interruption tests use disposable SQLite state, Git repositories and
fixture providers. Child-process tests terminate only the child owned by the
test after a boundary signal. Accelerated clocks exercise deadline behavior
without waiting for wall-clock hours. These fixtures establish local recovery
behavior under the tested process failures.

## Design references

Mosaic uses its own coordinator, SQLite records and workspace journal. Hermes
informed the distinction between a disappeared owner and a known result.
cc-delegate informed preservation of partial work. Paradev informed the
distinction between restoring an execution session and completing the task.
No upstream implementation code is incorporated.
[Hermes recovery source](https://github.com/NousResearch/hermes-agent/blob/aa5fb1cc952e26f207b6ec695ab3756f5d029cb4/tools/async_delegation.py#L295),
[Hermes worker contract](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban-worker-lanes),
[cc-delegate salvage source](https://github.com/EtienneLescot/cc-delegate/blob/367edf37b8c1eb8d0241153de0e75344293c44e6/server/jobs.py),
[Paradev session semantics](https://github.com/ParadevAI/Paradev/blob/2764273b198d46b1e39d8ed954ee3eb0141b82cc/apps/docs/content/docs/agent-sessions.mdx).
