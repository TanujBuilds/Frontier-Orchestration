# Stage 04 — Skills, Modes, and One MCP Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the reviewed collaboration runtime discoverable and usable from ordinary Codex conversations through focused skills and one installed MCP service.

**Architecture:** Reuse Dispatcher and the stdio MCP bridge, package the runtime once, and expose thin workflow instructions with progressive references. Preserve legacy entry points and records through explicit routing rather than starting competing schedulers or creating an always-on Codex supervisor.

**Tech Stack:** Node24, SQLite with WAL and synchronous=FULL, Git worktrees and journals, MCP SDK1.32.2, pinned Python research runtime, Playwright1.64.1 where applicable. Recheck versions before relying on them.

**Spec:** [Approved execution package](README.md) and [shared context](CONTEXT.md), based on the approved 2026-10-29 Codex + DeepSeek Collaboration Package. Starting source revision `714ed31a61a289503b63522d480c0790c0dc23c4`; later stages consume reviewed prerequisite receipt commits.

## Global constraints

- Codex remains the user interface; the dashboard is read-only. One MCP service owns dispatch.
- Four modes remain isolated: collaborative, DeepSeek-only, Codex-only, and bounded overnight review.
- One harness-managed DeepSeek task executes globally; native concurrency inherits host capacity and approved goal limits.
- Preserve exact approvals, stable identities, absolute deadlines, request spending, failed evidence, and ownership through restart, revision, and takeover.
- Do not change model runtime settings, authentication policy, credentials, trusted checks, or permissions through model output or automatic learning.
- Public tracked documentation contains no private endpoints, machine paths, credentials, or copied project source evidence.
- No push, primary-branch merge, public hosting, new provider, or experiment-lab expansion.

## Review Focus

- A skill installed on disk may still be undiscovered by the active host.
- Mode instructions must match server-side actor enforcement.
- Legacy jobs must not be resubmitted into a competing scheduler.
- Packaged code must not import the development checkout.
- Native role prose must not claim enforceable sandbox isolation.

## Current implementation and dependencies

Require accepted Stage02 and Stage03 receipts, actual tool schemas, and committed combined runtime. Stage01 contracts pin registration/progress models; do not independently rename them in skill prose. Read `.agents/skills/frontier-harness/{SKILL.md,agents/openai.yaml,references/operations.md,scripts/harness.mjs}`, existing overnight/research/task-queue entry points, and `src/harness/{mcp,tools,cli,package}.mjs`.

The base package copies the primary harness skill and runtime into a checksummed standalone directory. It already has an SDK client test that calls installed MCP tools against fixture state and detects source tampering. This is useful but does not prove discovery by the owner's actual native host or forwarding behavior of every new skill. The current skill description also says native_start returns a separate checkout even though historical implementation uses the integration checkout; correct this by requesting explicit candidate_v1 for new native work and documenting the legacy path.

## Ownership and package interfaces

Own `.agents/skills/frontier-harness/`, three focused skill directories, packaging code/tests, native role templates, and workflow documentation. Preserve existing skill frontmatter and user invocation preferences; do not make all skills explicit-only or replace the owner's unrelated global configuration.

Deliver these discoverable entry points:

- `frontier-harness`: goal preparation, selection, state, questions, controls, evidence, and workflow routing.
- `frontier-collaborate`: native implementation plus delegated DeepSeek candidates, supervision, review, revision, and integration.
- `frontier-deepseek-only`: bounded local planning/implementation/checks/integration, with unresolved questions to the user and no Codex fallback.
- `frontier-codex-only`: native implementation and deterministic public-source research, with no DeepSeek dispatch.

Keep `overnight-build`, `deep-research`, `deepseek-delegate`, and `task-queue` usable. Their instructions explain when to use their historical backend versus the new coordinator. Existing IDs/approvals/counters are never automatically resubmitted. New unified goals use the shared DeepSeek execution authority; historical independent clients are explicitly detected/documented and not falsely advertised as globally exclusive. Startup-scout deferral remains best effort across outside clients.

Package one immutable runtime, a file/hash manifest, the four entry skills, references, optional native role templates, and private configuration examples containing placeholders only. Sibling skills reference the same versioned installed service rather than copying executables per mode. Exclude connection.json, local-config.json, state databases, saved project sources, credentials, and machine endpoints.

## Tasks and test-first sequence

### Task 1: Pin behavior scenarios before authoring instructions

- [ ] Read skill-creator and writing-skills guidance. Use the existing user authorization for execution; do not insert a new planning approval just because a skill template suggests one.
- [ ] Build a fixture scenario table: broad request→prepare exact goal; repeated submission→same task; parallel implementation→candidate_v1; DeepSeek question→answer/helper; forbidden-mode request→reject; stopped task→same counters; uncertain request→inspect rather than resubmit.
- [ ] Forward-test current instructions and record concrete failure/missing behavior before changing them. Do not spend unbounded reviews per skill.
- [ ] Confirm installed tool names/argument schemas through MCP discovery rather than relying on prose inherited from this plan.

### Task 2: Author concise entry skills and detailed references

- [ ] Put selection triggers and critical invariants in SKILL.md; keep complete manifests, examples, recovery instructions, and role details in referenced resources.
- [ ] Provide examples showing actual idempotency keys, stable submission IDs, exact approval hash, allowed checks/paths, mode, and limits. Use disposable fixture paths/placeholders, not owner machine addresses.
- [ ] Teach main Codex to register native workers and report progress, wait at useful boundaries with events_wait capped30seconds, and perform independent useful work while DeepSeek executes.
- [ ] Teach native implementation agents to write only the assigned candidate checkout and return candidate evidence. Reviewer roles inspect read-only evidence; native host permissions remain inherited and role prose is not an enforcement boundary.
- [ ] Separate optional reviewer reservations from implementation tasks. Native model overrides must be supported by the host; unspecified choice inherits. Do not change model_provider or imply arbitrary models are available.
- [ ] Explain interactive follow-ups: queue by default; explicit steer changes in-scope work through coordinator revisions; stop requires verified quiescence. Scope expansion requires an exact approved goal revision without spending reset.
- [ ] Explain that MCP event availability does not guarantee a new native turn. Inactive collaboration waits; only explicitly selected overnight mode performs bounded background reviews.

### Task 3: Package once and test installation independence

- [ ] Add RED package tests requiring all four skills and references, shared runtime resolution, MCP dependency metadata, and exclusion of private settings/state.
- [ ] Extend packageHarness and verifyPackage without weakening symlink/path/checksum checks. A destination must be a new version directory, never overwritten in place.
- [ ] Add role templates as data/examples; avoid installing global agent roles or changing global concurrency during this candidate stage.
- [ ] Verify package runtime imports resolve entirely inside the standalone snapshot with source checkout unavailable to the test process.
- [ ] Test missing pinned dependencies, offline cache miss, malformed manifests, tampered roles/skills/runtime, and package path traversal. A failed build remains an inspectable failed candidate, not silently reused as valid.
- [ ] Run `node --test test/harness-package.test.mjs test/harness-mcp.test.mjs test/harness-cli.test.mjs` followed by `npm test` after code changes.

### Task 4: Mode and legacy forward validation

- [ ] Use SDK discovery and documented public tools to prepare/activate/submit/inspect/finalize fixture goals in each mode. No direct Store mutation substitutes for normal workflow success.
- [ ] Assert DeepSeek-only rejects native start, reviewer reservation, takeover, and supervisor-answer fallback; Codex-only rejects planner/model dispatch to DeepSeek even when a caller supplies a forged role/model field.
- [ ] Verify overnight mode preserves existing check-gated review bounds, and existing saved JSONL/research SQLite records remain readable unchanged.
- [ ] Exercise one project-local memory retrieval and protected lesson lifecycle through documented tools. Label existing edit_batch/backoff_zero evaluation as protected replay rather than general model self-improvement.
- [ ] Independently forward-test the installed skills using only their packaged instructions. Correct failures and run a focused second pass; do not broaden to new workforce capabilities.

## Completion gate and handoff

This stage produces a candidate package, not the final personal installation. Stage07 verifies actual native-host discovery in separate disposable state. The gate requires coherent entry routing, all four fixture modes, independent installed-runtime execution, tamper tests, legacy compatibility, and forward-tested instructions. Document whether actual host MCP refresh/restart is needed; never claim a configuration file guarantees tools are loaded into an already running conversation.

The receipt includes source/package hashes, skill inventory, commands, discovered tools, scenario outcomes, known host restrictions, and distinction between fixture SDK calls and real native-host calls. Preserve spending for any model-assisted forward tests and report native host accounting unavailable when appropriate. Pass Stage05 the final tool inventory so viewer authorization cannot accidentally classify a new mutator as read-only.

## Required handoff receipt

Use the shared receipt format in README.md. Include stage/objective; prerequisite and delivered commit SHAs; files/interfaces changed; exact test commands and exits; live versus fixture evidence; requests/usage where known; preserved IDs/deadlines/counters; artifact paths and SHA256 hashes; compatibility/rollback notes; limitations/blockers; and acceptance `passed` or `incomplete`. Do not mark this stage passed because this document exists. Keep private receipt details in local runtime artifacts and publish only sanitized summaries.

## Exact stage `/goal` prompt

> Complete Stage 04. Package the reviewed coordinator as one MCP service and provide the main skill plus focused collaboration, DeepSeek-only, and Codex-only entry points. Preserve existing overnight, delegation, queue, and research workflows through explicit compatibility paths. Verify mode isolation, native-agent coordination instructions, host lifecycle limits, deterministic research, and bounded learning. Build a standalone candidate package with private settings excluded. Independently forward-test its skills and actual MCP discovery without importing the development checkout. Do not activate the owner’s final installation yet.
