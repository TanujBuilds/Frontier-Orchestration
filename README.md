# Mosaic

Mosaic coordinates bounded coding work between your coding app and an existing model API. You describe the outcome, review the scope, checks and limits, and keep one record of the plan, implementation, review and corrections.

**Experimental MIT source preview — November 17, 2026.** The source is public at [TanujBuilds/Mosaic](https://github.com/TanujBuilds/Mosaic). There is no published, qualified binary download or one-command installer. Local package verification does not establish a clean-Mac installation, compatibility with your app account, or model quality. The [six-stage roadmap](docs/ROADMAP.md) separates accepted local evidence from the remaining launch gates.

## The coding workflow

Start with one worker: an already-running OpenAI-compatible API on your Mac, another computer, or a hosted service. Mosaic connects to that service; it does not install models or manage their servers.

1. Choose a coding app and workflow. The portable setup offers Codex, Claude Code, Cursor and Antigravity as host choices, with review through the selected app by default. Actual app connection remains a separate verification step.
2. Prepare an exact goal: repository revision, readable and writable paths, protected check commands, worker, review source, deadline and call limits. Review the concrete scope before activation.
3. The worker implements bounded assignments in an isolated candidate. The coordinator controls permitted edits, execution and capacity.
4. Protected checks run before review. The reviewer examines the checked diff and evidence, accepts it or requests focused corrections within the remaining limits.
5. Review acceptance and integration are separate steps. The result records what passed, what changed, and what remains blocked or unverified.

Workflows retain different roles: collaborative work allows Codex and API-worker implementation; DeepSeek-only excludes Codex implementation, review and fallback; Codex-only makes no DeepSeek calls; overnight review uses API-worker implementation with bounded review after passing checks. The historical `deepseek` actor/mode names remain protocol identifiers for the configured API worker. See [mode and lifecycle details](docs/MOSAIC_CODING_CORE.md).

You can optionally configure two or three workers with specialties, a default worker and a planner. Routes are explicit choices, not measured coding ability. Profiles that reach the same physical service must share capacity; adding profiles does not create inference slots. Two machines serving one distributed model API count as **one endpoint**. Guided setup defaults total, worker and shared-service concurrency to one; higher limits require an explicit choice.

## Try the source

Use Node.js **24.22.0**, the runtime pinned by the current package builder, and npm. Git is needed for the checkout and coding worktrees. The portable package target is Apple Silicon macOS; a broader platform support matrix has not been qualified.

```sh
git clone https://github.com/TanujBuilds/Mosaic.git
cd Mosaic
node --version
npm ci --ignore-scripts
node src/demo.mjs "Describe a fake note-taking workflow; do not access files or external services."
node --test test/coordinator.test.mjs
```

The demo needs no credentials or model endpoint. It prints **FAKE MODEL DEMO**, automatically approves a fake plan, exercises an answer/review/revision sequence, and writes an ignored JSONL event log under `.data/jobs/`. It makes no model calls, applies no task file edits and runs no protected coding checks. Its `accepted` result proves the fake coordinator flow only. The focused test uses in-process doubles; it is not a live-model test. Both can run without installing dependencies.

After dependency preparation, inspect the current entry points without starting services or changing setup:

```sh
node src/beta/cli.mjs --help
node src/harness/cli.mjs --help
```

The supported development line is `>=24.22.0 <25`, with **24.22.0** pinned in source CI. After exact-lock dependency preparation, `npm test` runs the explicitly selected portable source profile; `npm run test:source -- --list` shows its entries and separate qualification gates. See [development setup](docs/DEVELOPMENT.md) and [test selection](docs/TESTING.md) for the full required Darwin profile. A source checkout is not a personal installation. Running setup, registering an MCP bridge or starting a real task needs its own private configuration and explicit scope.

## Which entry point is which?

| Path | Purpose | Boundary |
| --- | --- | --- |
| [Original demo](src/demo.mjs) and [terminal handoff](docs/MVP.md) | Fake JSONL coordinator; original text-only Codex → DeepSeek → Codex milestone | Text handoff and historical live observations are separate from current coding qualification. |
| [Legacy overnight workflow](docs/OVERNIGHT.md) | Sequential staged coding in a Mac worktree with protected checks and review | DeepSeek plans and implements; Codex reviews passing stages, with optional explicitly requested pre-stage guidance and no Codex code rescue. |
| [Opt-in coding core](docs/MOSAIC_CODING_CORE.md) | Four modes, versioned goals/tasks, native candidates, routing, recovery and observer | The `frontier-harness` bridge and installed core have their own state and lifecycle. Research remains parked. |
| [Portable beta](docs/TERMINAL_BETA.md) | `mosaic` setup, diagnostics, terminal observer and separate `mosaic-beta` bridge | Local Darwin arm64 package candidate, not a published release. It does not migrate core goals or approvals. |

For package development, read [installation and recovery](docs/PORTABLE_BETA_INSTALL.md), [native check artifact requirements](docs/NATIVE_CHECK_ARTIFACT.md), and [release evidence](docs/PORTABLE_BETA_RELEASE.md). The [archive download prototype](distribution/README.md) requires an explicit URL and independently trusted digest. The [read-only candidate verifier](docs/PORTABLE_RELEASE_EVIDENCE.md) checks supplied bytes and bindings; it cannot authenticate a publisher or establish live readiness. These are local candidate instructions, with dated historical examples. No archive URL, Homebrew tap, signing identity or authenticated public installer is supplied here.

## What is established?

The latest accepted checkpoint documented here is [the November 17 owner-workflow foundation](CHANGELOG.md#source-checkpoint--november-17-2026-owner-workflow-foundation), source `202338e0a143fef4150d1cca3ccdb49661778890`. It adds bounded provider recovery, manual-model retry eligibility without discovery requests, strict UTF-8 request intake, current-state backup consistency fixtures and preservation of primary SQLite errors when rollback cleanup fails. Its required Mac suite passed **2,555/2,555 tests**; separate portable source CI passed **2,156/2,156**. Acceptance covers source, owned native/browser fixtures and disposable installed-package composition.

Local archives `0.1.0-beta.192` and `.193` passed staging and byte/mode verification and supplied the fresh pair for the required installed-package fixtures. The [earlier November 17 checkpoint](CHANGELOG.md#source-checkpoint--november-17-2026), source `ddd922c`, retains the separate beta188/189 wrapper install → installed support → update → installed support proof. The [November 16 checkpoint](CHANGELOG.md#source-checkpoint--november-16-2026) and beta184/185 also retain their original scope. These labels identify **local artifacts, not public releases**. The dated records concern their named revisions; later source commits require their own qualification.

Read the contracts for [redacted support bundles](docs/SUPPORT_BUNDLE.md), [reviewed candidate staging](docs/REVIEWED_CANDIDATE_STAGING.md), [package verification limits](docs/PACKAGE_VERIFICATION_LIMITS.md) and [terminal qualification](docs/TERMINAL_QUALIFICATION.md). Notice inclusion preserves the dated audit and its unresolved legal/provenance questions; it does not establish distribution clearance or publisher authenticity.

Selecting an app, listing models, or passing a small inference probe does not establish an actual host connection, coding quality or usable context capacity. Actual host discovery/calls (M003), useful ordinary owner projects (M079), three independently addressable qualified workers (M063), clean-Mac use and authenticated distribution remain separate gates. M063 remains unproven. The protected native network/Postgres proof (M001) remains blocked: the accepted boundary denies TCP/Unix access and the required Postgres demonstration is absent.

Review through an app is pull-based. An inactive or disconnected app leaves a durable review wait; Mosaic does not promise to wake its chat or silently switch to an API reviewer. Explicit API review can run automatically in collaborative or overnight mode when the approved policy permits it and the reviewer is available. Legacy detached overnight review has its own configured reviewer.

## Context and authority

Approved task context goes to the configured worker endpoint. A worker on another computer or a hosted API receives that context off the Mac. Review in a coding app can use a cloud service even when the worker is local; an explicitly selected API reviewer has separate credentials and usage. Keep task logs, private settings, keys and raw evidence out of public issues and commits.

The coordinator owns exact approvals, plan versions, paths, checks, budgets and execution ownership. Reading these docs, choosing a mode or receiving model text grants no execution permission, spending allowance or mode transition. Interrupted or uncertain work retains its holds until recovery establishes ownership and quiescence.

## Explore and contribute

Start with [contributing](CONTRIBUTING.md), [development setup](docs/DEVELOPMENT.md), and [test selection](docs/TESTING.md). Read the [architecture and code map](docs/ARCHITECTURE.md), [current product context](docs/PRODUCT_CONTEXT.md), [six-stage roadmap](docs/ROADMAP.md), and [milestone history](docs/MVP.md). Dependency and native attribution records are in [third-party notices](THIRD_PARTY_NOTICES.md) and [distribution provenance](docs/DISTRIBUTION_PROVENANCE.md); unresolved distribution questions remain explicit. For a bug, provide the commit/package version, platform, expected and actual behavior, and a small redacted reproduction through [GitHub issues](https://github.com/TanujBuilds/Mosaic/issues). Pull requests should identify scope and exact checks, and distinguish fixtures from real host/model evidence. Security reporting has an unresolved private-channel gap; read [SECURITY.md](SECURITY.md) before sharing vulnerability details.

Mosaic is licensed under [MIT](LICENSE). Internal `frontier-*` package and protocol names are retained for compatibility.
