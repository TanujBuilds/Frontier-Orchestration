# Native-host mutation preflight

Updated 2026-11-01. A healthy stdio MCP connection proves discovery, not permission
to prepare, activate or submit a goal. Keep these gates separate. The coordinator
marks mutations `readOnlyHint: false`; preserve that metadata.

A disposable CLI probe previously used `approval_policy="never"` and
`sandbox_mode="read-only"`, without per-tool MCP overrides. Discovery worked, but
`goal_prepare` failed in the host with “MCP tool call requires approval, but
approval policy is never,” before returning a goal ID. This does not establish
whether an appropriately scoped installed host can dispatch.

The current [official MCP configuration guide](https://learn.chatgpt.com/docs/extend/mcp)
and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
support server `enabled_tools`, `default_tools_approval_mode`, and
`tools.<tool>.approval_mode`. The published
[configuration schema](https://developers.openai.com/codex/config-schema.json)
includes `approve` in the per-tool enum. For a user-authorized disposable probe,
use invocation-local overrides for exactly the intended server and tools:

```toml
[mcp_servers.frontier-harness]
# Bind the reviewed entrypoint and fresh fixture state separately.
enabled_tools = ["tools_list", "registry_list", "goal_get", "task_get", "queue_get",
                 "goal_prepare", "goal_activate", "task_submit"]
default_tools_approval_mode = "writes"

[mcp_servers.frontier-harness.tools.goal_prepare]
approval_mode = "approve"
[mcp_servers.frontier-harness.tools.goal_activate]
approval_mode = "approve"
[mcp_servers.frontier-harness.tools.task_submit]
approval_mode = "approve"
```

This is a supported configuration hypothesis, not a demonstrated guarantee of
its interaction with a host's effective `never` policy or managed requirements.
Record the actual CLI version/help, exact overrides, original approval/sandbox
policy and resulting tool transcript. A parsed configuration or SDK invocation
cannot replace the native-host test. A rejection stays a blocker; do not retry
through another transport, weaken global policy or change mutation annotations.

Before launching a paid host session, the main owner must reserve it in the
original resource ledger, cap the entire session by its original parent deadline
and retain the concrete fixture manifest, task, idempotency keys and input hashes.
Use a new private state root with `environment="fixture"`, no provider secrets,
no research adapter and no old queued work. An explicit collaborative consult
task with actor `codex` remains `codex_ready`; do not start native execution. The
worker only claims queued DeepSeek tasks, so this demonstrates submission with
zero backend requests rather than consuming an inference request.

The host must call real `registry_list` and `tools_list`, confirm mutation metadata,
prepare the exact input, activate only its returned ID/hash, submit the exact
assignment, and inspect the resulting goal/task. Independently verify the stored
manifest, task identity, zero request rows/attempts/planner work, and quiescence.
Capture raw tool calls and exposed native usage. A host session may contain
multiple turns/requests; unexposed usage remains unknown.

Stop the disposable coordinator cleanly and preserve failed as well as passing
transcripts. This fixture does not prove desktop refresh, installation, final
candidate first use, research quality or a physical phone test. After all
pre-installation gates pass, verify the frozen installed candidate in the
separately authorized fresh host session. Never restart an active owner app just
to refresh tool discovery.
