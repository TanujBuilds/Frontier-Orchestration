# Optional native system roles and model selection

Templates in `../roles/` contain only developer_instructions. They are opt-in
native role examples, not installed global configuration. Use the current host's
supported role-selection mechanism, or include the template's instructions in a
normal bounded assignment. Discover spawn/join/interrupt tool schemas from the
host. The harness does not supply a host-spawn tool and role fields do not grant
MCP authority. All roles inherit the host's model provider, sandbox and MCP tools;
restrictions are cooperative. Main verifies returned evidence.

| Role | Assignment contract |
| --- | --- |
| implementer | Edit only assigned files in returned candidate; return diff/checks/remaining issues |
| explorer | Read scoped evidence/files; return findings and paths, no edits |
| reviewer | Read candidate/evidence; return acceptance gaps/findings, no edits or acceptance calls |

Unspecified native selection inherits the host. Private provider configuration
may define `nativeRoleModels` keyed by implementer/explorer/reviewer/supervisor and
`nativeModels` as the explicit allowlist. Example placeholders are in
`../examples/provider-config.json`. The parent reconciles a role default with
actual host availability before launch. A registration validates metadata; it
does not change a host model by itself. Use an explicit model only through the
host's supported parameter and confirmed allowlist, then pin requested/resolved
values in registration when observed. Unsupported explicit or role-default
selection fails clearly. Do not silently reroute, set model_provider, override
sandbox/MCP, introduce another cloud provider, or claim a resolved model you
cannot observe. An inherited unknown resolved model is null, not a guessed name.

Native coding start accepts a registration and creates its own managed ID. For
managed text/explorer/reviewer correlation where needed, discover
`agent_register` version1 fields: taskId, hostAgentId nullable, role, actor, model
{requested,resolved} nullable. `agent_report` uses the returned agentId, version1,
status, summary and evidenceIds; it does not change task authority. Preserve
hostAgentId registration identity; a conflicting correlation is an error.
