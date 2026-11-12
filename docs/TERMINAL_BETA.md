# Mosaic Beta for Apple Silicon Macs

Mosaic Beta connects your selected coding host to a local coordinator. Setup offers Codex, Claude Code, Cursor and Antigravity, one or more explicitly configured API workers, specialty routing and optional API review. Review defaults to the selected host. The initial archive targets native Apple Silicon macOS and includes its coordinator Node.js runtime and dependencies. The separate native check artifact supports protected checks without Codex. A clean Mac may prompt you to install Apple Command Line Tools when coding checks first need Git. Actual host versions and clean-account installation remain separate release gates; see [release evidence](PORTABLE_BETA_RELEASE.md).

## Install

From the directory containing the matching archive and SHA256 file, substitute the version you received:

```sh
shasum -a 256 -c mosaic-beta-VERSION-darwin-arm64.tar.gz.sha256
tar -xzf mosaic-beta-VERSION-darwin-arm64.tar.gz
cd mosaic-beta-VERSION-darwin-arm64
./install
~/.local/bin/mosaic setup
```

The installer checks package integrity and offers to append a managed PATH block to `~/.zshrc` when needed. Use `./install --no-path` to skip that prompt. Open a fresh terminal after accepting a PATH change. Setup previews the selected host, profiles, review source, routing, concurrency and exact native artifact identity. Private configuration lives under `~/Library/Application Support/Mosaic Beta/config`; bearer values use a separate owned `0600` credentials file. Existing schema-1 settings remain readable until explicit preview/cancel/apply migration. Migration does not rewrite saved goal identities or approvals.

Choose host-only use or explicitly supply each already-running local/remote API endpoint, model ID and credential reference. Mosaic does not install models or change model servers. A provider may implement Chat Completions without model discovery; enter its model ID manually. Completed responses are the default. Select streaming only for providers that send Chat Completions SSE with a terminal marker. The optional inference test requires a separate opt-in and sends one fixed prompt with no repository data. No inference occurs merely because setup, preview or discovery runs. A separately configured API reviewer does not use the coding app's account and has no automatic fallback from a closed host.

All real hosts receive exact manual MCP registration instructions in the new portable setup path: a safe atomic comparison is unavailable through the supported host configuration interfaces. Follow the preview in the selected app; saving configuration does not prove the app loaded it. Disposable-home tests use a private fixture registration adapter. Only unchanged installer-owned bindings can be removed; manual and unrelated host entries are preserved. Historical schema-1 Codex setup remains a separate compatibility path. See [host compatibility](HOST_COMPATIBILITY.md) and [installation and recovery](PORTABLE_BETA_INSTALL.md).

## Run

Reopen the selected host after registration. Start a chat in the intended repository and use this prompt:

> Use Mosaic Beta in this repository. Inspect the mosaic-beta registry, ask me to choose a workflow if needed, then prepare an exact goal and show me its scope and limits for approval before activation.

The four available workflow policies are collaborative, API-worker-only (`deepseek_only` in the MCP protocol), host-only (`codex_only`) and overnight review. Confirm the approved manifest, Git base, literal file/check scope, provider pool, routing and budgets in the host. Host review waits durably when the app closes; an inactive chat is not guaranteed to wake. Use `mosaic` to observe activity in another terminal. Press ↑ or ↓ to select an assignment, Enter to see bounded saved evidence, g to choose a goal, and q or Ctrl-C to close the observer. Press **a** from any screen to jump to the current project. It prefers running work, then the most recently worked project, and says when nothing is running or native activity is unconfirmed. The result is labeled as the last check; press a again to refresh the selection. This shortcut only changes your view. Approvals stay in the host.

Use **[** for older handoffs and **]** for newer handoffs. In goal selection and details, these keys page up and down. Page Up/Down (Fn + ↑/↓ on a Mac keyboard) still work.

If the existing Mosaic coding core is installed in its standard user location, the terminal also discovers its read-only viewer connection. A chat using `frontier-harness` writes to that existing service; a chat using `mosaic-beta` writes to the separate beta service. The terminal labels the service it is watching, follows work when the current service is empty or another service becomes active, and retains the selected service when both have active work. Use `mosaic --source core` or `mosaic --source beta` to choose explicitly. No goals, approvals or settings are migrated between services. Older core versions load saved handoffs in bounded pages; the terminal shows a loading message while catching up. If the watched service disconnects, its last saved view stays visible as stale.

```sh
mosaic status --once
mosaic doctor
mosaic setup
mosaic off
mosaic on
mosaic uninstall
```

Doctor checks configured capabilities and provider model discovery without sending a completion; its evidence distinguishes documented configuration, fixtures and actual probes. The status command also works when redirected to a file. `off` stops new dispatch while retaining recoverable state and execution ownership; `on` resumes the service's admission policy. Uninstall removes only owned, unchanged beta bindings and retains versions, private settings and evidence. Existing core, manual or modified registrations are preserved. Resolve active or prepared beta work in its host before maintenance. If a prepared worker-bound revision blocks maintenance, stop its goal and finalize it as partial to retire the revision. Native uncertainty cannot be cleared merely by timeout, process exit or switching a version pointer. Setup can resume an approved interrupted change. Relocation or a different native artifact needs a new exact approval; saved literal check paths are never rewritten silently.

For isolated local verification, use `./install --home /absolute/disposable/directory --no-path`, run the installed `mosaic setup`, then start the isolated coordinator with `mosaic serve`. Select a non-Codex host to exercise the native check path with Codex absent. This mode uses a private fixture registration and dummy loopback credentials. It does not certify an actual host app, account, login startup or clean-machine installation.

## Validation scope

November 12, 2026: portable stage 16 separates source tests, the disposable extracted-package fixture and external release gates. The current acceptance record is [release evidence](PORTABLE_BETA_RELEASE.md). The native foundation accepted in stage 15 is historical source evidence; it is not by itself an installed-package pass. Real host/account versions, live two-provider operation, clean-machine setup, signing/notarization, public license/source audit and publication remain NOT RUN for this candidate unless a distinct dated receipt records them.

On November 9, 2026, the Apple Silicon package `0.1.0-beta.102` (`fb368a1`) completed a live overnight coding task in an isolated home on the development Mac. The existing Spark service handled one planning request and one coding request. The protected check passed, Codex accepted the candidate in one independent review, and the coordinator integrated the change and finalized the goal. The fixture processes shut down after the run.

The full test suite passed 690 tests at `4372a38`. The beta and harness observer suites passed 26 tests at `f931136`, including the 20-column renderer change made after the live-tested build.

Setup and LaunchAgent registration on a separate clean macOS account or VM and a live hosted-provider coding task remain unverified.
