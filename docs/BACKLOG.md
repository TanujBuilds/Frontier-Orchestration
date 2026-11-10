# Approved task backlog

Use a backlog when several assignments fit inside one already approved Mosaic goal. For example, submit an inspection, a follow-up that depends on its accepted result, and a separate example task in one operation. The coordinator's existing worker decides when each assignment is eligible. The original goal deadline continues while work waits.

## Preview and submit

Use the active goal's ID and exact approval hash from `goal_get`. Save this shape to a local JSON file. Replace the example goal ID and hash with the approved values.

```json
{
  "goalId": "example-goal-id",
  "expectedGoalHash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "submissionId": "inspect-and-follow-up",
  "items": [
    {
      "key": "inspect",
      "task": {
        "kind": "consult",
        "objective": "Explain how the current example handles cancellation",
        "acceptance": ["Identify the preserved state and evidence"]
      },
      "dependsOnKeys": []
    },
    {
      "key": "follow-up",
      "task": {
        "kind": "consult",
        "objective": "Summarize the follow-up for the example owner",
        "acceptance": ["Refer to the accepted inspection"]
      },
      "dependsOnKeys": ["inspect"]
    }
  ]
}
```

```sh
node scripts/mosaic-backlog.mjs preview --input group.json --root "$STATE_DIR"
node scripts/mosaic-backlog.mjs submit --input group.json --idempotency-key backlog-inspect-01 --root "$STATE_DIR"
node scripts/mosaic-backlog.mjs inspect --goal "$GOAL_ID" --root "$STATE_DIR"
```

These commands use the running local coordinator's authenticated operator connection. Omit `--root` to use the existing harness CLI's default state directory. The MCP equivalents are `backlog_preview`, `backlog_submit` and `backlog_inspect`. Discover their schemas with `tools_list`. The submit tool takes the same object plus `idempotencyKey`.

A group holds 1–20 tasks and fits within the approved goal's remaining task cap. Supply unique local keys and use `dependsOnKeys` for edges between items in that group. Each item takes the regular task fields except `submissionId` and `dependsOn`, which the coordinator derives. Task limits, actor, capabilities, source scope, permissions and protected check mappings remain subject to the approved manifest. JSON files must be smaller than 1 MiB and fit in the local API request envelope.

Preview reports whether the proposed graph validates against the current approval. It reserves no task slots, so submit checks approval and capacity again inside the transaction. All group tasks and references commit together. Keep the same submission ID and key when retrying the same payload. Reusing either identity with different content conflicts. A revised approval requires a fresh preview and a new submission identity for new work. Existing tasks follow the normal explicit rebind rules.

Overnight v2 uses its own validated planner graph. Its assignments remain visible through the existing task and queue tools. Native assignments need a supported active host and the normal explicit native-start flow. The installed beta's research restrictions apply to backlog submissions.

## Read the queue

Inspect returns the saved group references and a current projection of each task. Use `--group` to select a group, or pass the returned `nextCursor` to `--cursor` with the same filter. Pages default to 50 groups and allow up to 100. A group's item list stays bounded by the submission limit. MCP clients can use `goalId` and/or `groupId` and the same pagination fields.

- `sourceStatus` is the coordinator's saved status. Each projected status has a `reasonCode` and explanation. A missing task or stale approval remains visible as a hold.
- `waiting_dependency` means an upstream task still needs acceptance. A failed or stopped prerequisite can block its dependents while independent work remains eligible.
- `waiting_review` covers saved review or integration work. Protected checks passing alone do not accept a coding result.
- `waiting_host` covers native work that needs its supported host. `waiting_answer` identifies a saved owner or supervisor question. Certified non-dispatch reconnect waits appear separately from uncertain ownership.
- `ready` describes eligibility in the saved view. A worker still needs its normal slot, lease, compatible runtime and request budget.
- Effective priority can be higher than the task's own priority when a downstream blocking task depends on it. The coordinator computes that priority for scheduling.

Use existing `task_priority` with a reason to change priority. Use `work_control` with `pause`, `stop` or `resume` and the saved task ID. For queued work, use `stop` to retain the group, task and evidence while preventing progression. Owned work follows its existing safe boundaries. Resume retains the original deadline, approvals and spending. Reconcile uncertain ownership through the existing recovery path.

## Disposable demo

```sh
demo_dir=$(mktemp -d)
node scripts/mosaic-backlog.mjs demo --output "$demo_dir"
```

Open the transcript path printed by the command. It contains views of the same three-task group at submission, with a task awaiting review, after reopening the same SQLite state, and after all three tasks are accepted. The demo uses a real local coordinator and worker with simulated provider responses and operator decisions. The provider stub receives zero calls during preview, submission and replay, and one call per completed task. The demo creates a unique subdirectory under the supplied output directory.
