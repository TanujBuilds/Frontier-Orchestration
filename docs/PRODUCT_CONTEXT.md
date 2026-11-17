# Product context and decisions

Current orientation: November 16, 2026. Mosaic is an experimental MIT source preview at [TanujBuilds/Mosaic](https://github.com/TanujBuilds/Mosaic). The accepted source checkpoint is `a23bae40d733fd711075ca798f83fbe9cc5ac633`; the [changelog](../CHANGELOG.md) separates its local verification from public binary qualification. Machine-specific handoff notes and raw task evidence stay private and outside Git.

## Purpose and current direction

Using several models on one job means carrying context between tools, reconciling plans and deciding which results to trust. Mosaic keeps one versioned goal, bounded assignments, checks and review evidence so the user can see what was done and what remains uncertain. Useful checked results with less manual coordination are the goal; model activity alone is not success.

The common path uses a coding app, one already-running worker API and the local coordinator. A worker can run locally, on another computer or through a hosted API. Optional specialty routing adds profiles with explicit shared-capacity limits. Two machines serving one distributed model are still one API endpoint. The application integrates with an existing service; model deployment, weights, tunnels and server tuning are outside its responsibility.

## Roles and modes

- **User:** chooses the outcome and workflow, authorizes the exact scope/checks/limits, and approves any required expansion or transition.
- **Coordinator:** owns plan versions, approval hashes, task state, routes, capacity, execution ownership, evidence and integration guards. Model text is a proposal or result, never execution authority.
- **API worker:** plans or implements bounded work where the selected mode allows it. The stable `deepseek` protocol alias does not require that every configured worker be DeepSeek.
- **Coding app/native actor:** provides the control and review surface; may also implement in explicitly selected collaborative or Codex-only goals. App-based review can use cloud inference even with a local worker.

| Workflow | Implementation and review boundary |
| --- | --- |
| Collaborative | Native Codex and API workers may implement in separately owned candidates. Main Codex normally reviews and integrates; an explicitly approved API review policy can supply review, with integration separately guarded. |
| DeepSeek-only | API-worker planning and implementation; protected checks govern acceptance. No Codex implementation, review or fallback. |
| Codex-only | Native Codex implementation with no DeepSeek calls. |
| Overnight review | API-worker implementation with bounded review after passing checks. The preserved legacy workflow has the stricter review-only frontier roles below. |

An explicit current choice takes precedence over an active goal's pinned mode, then an explicitly owner-saved project preference. If none exists, ask once. Selection is not dispatch or spending authorization. A different mode requires a supported authorized transition or separately authorized goal and preserves prior deadlines, spending and ownership. See [coding-core behavior](MOSAIC_CODING_CORE.md).

## What exists and what is not yet proven

The original JSONL fake coordinator and text terminal handoff remain available. The sequential overnight runner has protected worktrees/checks, review and durable reports. The opt-in four-mode coding core adds versioned goals/tasks, native candidates, routing/capacity and recovery. Portable beta adds separate setup, diagnostics, host previews, a terminal observer and locally built Darwin arm64 packages. See the [architecture](ARCHITECTURE.md) for source locations and distinct state stores.

The November 16 M027 acceptance covers source, owned fixtures and disposable installed-package proof. Listing models and fixed-message inference tests establish limited connectivity evidence, not coding quality, context capacity or an actual app connection. Actual host discovery/calls (M003), useful ordinary owner projects (M079), three real independently addressable workers (M063), clean-Mac use and distribution authenticity remain separate requirements. A first owner task alone does not close M079. M001 remains blocked by the native TCP/Unix boundary and absent Postgres proof. Public source availability does not waive these gates.

Host review is pulled by an active conversation. A disconnected app retains a durable wait; no automatic chat wakeup or silent API fallback is promised. Explicit API review can run automatically in collaborative or overnight mode under its approved policy and limits. Legacy detached overnight review has its own configured reviewer. Research remains parked in this coding-core scope; historical research packets grant no new authority.

## Development, privacy and release boundaries

The repository's own source development can use native Codex under an explicitly selected scope; those development tools are separate from the application's worker adapters. Preserve the stricter legacy overnight roles when working through that mode. A document, skill, model response or setup choice grants no permission to run commands, edit files, contact providers or expose task content to a cloud service.

Approved context goes to the selected worker; remote/hosted workers receive it off the Mac. App review may use its cloud provider, and API review has separate authentication and usage. Keep endpoints, credentials, personal paths, private manifests, logs and raw databases outside tracked public files. Keep unknown usage and actual model identity unknown rather than inferring them from an actor name.

The source is public, while qualified binary publication remains pending. Local archive labels and checksums are not public releases or publisher signatures. Do not rename working `frontier-*` identifiers for presentation, silently rewrite runtime/approval pins, or treat an uncertain owner as free capacity.

## Dated decision history

- **October 2026:** the original “Local AI Orchestrator” brief explored model roles. The first milestone became a text-only Codex → DeepSeek → Codex handoff; see [MVP history](MVP.md).
- **October 21, 2026:** after frontier-heavy planning and rescue exhausted a usage window, the owner selected review-only frontier operation for legacy overnight coding. DeepSeek drafts 1–10 ordered stages and implements them; defaults are five attempts and at most two Codex reviews per stage, eight hours, and a thirty-minute provider reconnect window. No routine Codex assignments, default Codex planning, code edits or repair fallback are allowed in that workflow. Protected checks precede automatic review; scope expansion needs a newly approved plan.
- **October 22, 2026:** the owner additionally allowed one optional, explicitly requested Codex guidance call before a legacy stage starts. It does not authorize Codex implementation or rescue. Historical narrow pilots do not close the full overnight feature gate; see [verification](VERIFICATION.md) and [overnight contract](OVERNIGHT.md).
- **November 4, 2026:** a separately scoped personal coding core established four explicit modes. Collaborative and Codex-only modes allow native implementation; this exception does not change the legacy overnight restrictions. That personal installation history is not portable-host qualification.
- **November 12–16, 2026:** local portable package, setup, diagnostic and guided multiple-worker work was accepted in source/fixture/installed scopes. Public host/model and clean-machine gates remain distinct.
- **November 16, 2026:** the owner prioritized public GitHub source and convenient download preparation, superseding earlier GitHub-last notes. The repository became a public MIT source preview; qualified binary publication remains pending.
