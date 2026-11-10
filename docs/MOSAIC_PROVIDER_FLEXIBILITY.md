# Choosing an API worker in Mosaic

Use `mosaic setup` to choose Codex plus an OpenAI-compatible API worker in the terminal beta. Configure the worker's display name, HTTP(S) base URL, optional bearer key, model ID, and completed JSON or streaming SSE responses. Then prepare a **new** goal and approve its exact manifest hash. The manifest shows the selected worker profile and the mode's existing review policy. Use the signed-in Codex reviewer where the selected mode calls for it. The beta keeps Overnight v1 as its default when the version is omitted. Explicit Overnight v2 requires the existing exact preflight and staged review gates.

When setup offers to request model IDs, choose yes to look up the endpoint's `/models` route. Selecting an advertised ID binds the requirement that the exact ID be advertised before each completion. If a new profile's selected ID was absent, setup shows that it will use manual selection. For an existing advertised profile, Enter retains the requirement and an explicit no switches to manual. `mosaic doctor` can check discovery. The optional setup test sends one short completion without repository data. Neither a model list nor the setup test proves that the model can produce valid Mosaic coding actions.

## What an approval binds

A beta worker profile binds the base URL, requested model ID, profile revision, display name, response mode and any explicit capabilities. The profile revision is a local configuration identity. Model aliases may resolve to a provider-controlled backend. Mosaic records the requested ID separately from the reported model when the provider supplies one. Use a stable, explicitly versioned provider ID if the endpoint offers one.

Beta setup stores the bearer key separately in private settings. It goes to the selected endpoint in the Authorization header. The profile, approval hash and task evidence use the credential-free identity. The adapter redacts literal and JSON-escaped bearer echoes from visible and saved output, including echoes split across SSE frames. A worker role and provider selection do not grant tool or shell authority. Mosaic still validates structured output, controls file access and edits, runs protected checks, and records the review and integration decisions.

Optional profile fields are additive. A profile created before this change keeps its original shape and behavior. The established core DeepSeek path keeps its DeepSeek-specific request options. Generic API workers use the common completion payload. Saved protocol actor labels such as `deepseek` still identify the autonomous worker role.

For an explicit capability profile, the supported contract is:

```json
{
  "protocol": "mosaic-structured-v1",
  "transports": ["json", "sse"],
  "modelDiscovery": "advertised"
}
```

- `protocol` declares that the endpoint is configured for Mosaic's existing planning, structured coding and consult exchange. It is a local declaration. Providers do not advertise this Mosaic-specific contract through `/models`.
- `transports` lists a nonempty subset of `json` and `sse`. It must include the configured response mode. Normal setup records the selected mode.
- `modelDiscovery` is `advertised` or `manual`. Advertised mode confirms the configured model ID before each new completion. Manual mode uses the exact configured ID. Both are bound to the approved profile.

If a running service detects changed settings or an old goal's approved profile differs from the current one, Mosaic refuses worker dispatch. A revision cannot swap the profile on an approved goal. Use the existing goal controls to stop and finalize old work where appropriate, reconfigure when maintenance is permitted, then prepare and approve a new goal. The original goal retains its model evidence, spending and deadline.

## Completion outcomes

Mosaic validates the declared capabilities and selected model before sending a completion. An incompatible declaration, discovery failure or pin mismatch produces no completion POST. Authentication rejection is recorded separately from an ambiguous interruption. If an SSE connection closes before a complete terminal marker and finish reason, Mosaic treats the request as ambiguous. A cleanly terminated stream can still report a length limit, which the existing planning and coding paths handle as truncated output. No failure routes to another provider, and existing reconnect and spending rules still apply. Overnight v2 uses `/models` as its non-inference readiness probe during a reconnect wait, including for manual profiles. A manual endpoint without that route can serve ordinary completions, but a reconnect wait cannot verify recovery there and can expire within the original deadline.

## Extending the worker harness

The current adapter sends model messages and receives text or structured actions. It relies on Mosaic for scope, worktrees, bounded edits, protected checks and review. A future OpenCode adapter would need an explicit runtime and version contract, permissions enforced at process launch, stable run/session identity, bounded evidence capture, cancellation and crash reconciliation, and the same deterministic acceptance gates. A comparison could use identical fixture tasks and check declarations to measure candidate quality, elapsed time and review calls before enabling that adapter.

The implementation is independent. The design follows the references' separation of model, runtime and role, and their distinction between runtime availability and specific tools or lifecycle capabilities. [Augani orchestration skill](https://github.com/Augani/agent-orchestrator/blob/8d9b897c49500e8e1b54ec8028352544db95618d/plugins/agent-orchestrator/skills/orchestrate-cli-agents/SKILL.md) · [Hermes runtime compatibility](https://hermes-agent.nousresearch.com/docs/user-guide/features/codex-app-server-runtime) · [Paradev agent integration](https://github.com/ParadevAI/Paradev/blob/2764273b198d46b1e39d8ed954ee3eb0141b82cc/apps/docs/content/docs/agent-integration.mdx)

## Fixture verification

Run the provider, pinning and Overnight fixtures from the repository root.

```sh
node --test --test-concurrency=1 test/mosaic-flexibility*.test.mjs
```

These tests use disposable coordinators and loopback endpoints. Real provider compatibility and installed release validation are separate.
