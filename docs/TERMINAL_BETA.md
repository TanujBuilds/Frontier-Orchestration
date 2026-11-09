# Mosaic Beta for Apple Silicon Macs

Mosaic Beta uses Codex as its host and reviewer. You can also configure one OpenAI-compatible Chat Completions API worker. Use a native arm64 terminal on macOS. The archive includes Node.js and runtime dependencies. Install the Codex CLI separately and sign in with `codex login`. A clean Mac may prompt you to install Apple Command Line Tools when protected coding checks first need Git.

## Install

From the directory containing the matching archive and SHA256 file, substitute the version you received:

```sh
shasum -a 256 -c mosaic-beta-VERSION-darwin-arm64.tar.gz.sha256
tar -xzf mosaic-beta-VERSION-darwin-arm64.tar.gz
cd mosaic-beta-VERSION-darwin-arm64
./install
~/.local/bin/mosaic setup
```

The installer checks package integrity and offers to append a managed PATH block to `~/.zshrc` when needed. Use `./install --no-path` to skip that prompt. Open a fresh terminal after accepting a PATH change. Setup previews the separate `mosaic-beta` Codex MCP registration, skill and LaunchAgent. It saves private configuration under `~/Library/Application Support/Mosaic Beta/config`.

Choose Codex only or supply an API base URL, model ID and optional bearer key. A provider may implement Chat Completions without supporting model discovery. Enter the model ID manually in that case. Completed responses are the default. Select streaming only for providers that send Chat Completions SSE with a terminal marker. The optional connection test sends one fixed prompt with no repository data. Coding workflows still require protected checks and their selected review policy.

## Run

Reopen Codex after setup. Start a chat in the intended repository and use this prompt:

> Use Mosaic Beta in this repository. Inspect the mosaic-beta registry, ask me to choose a workflow if needed, then prepare an exact goal and show me its scope and limits for approval before activation.

The four available workflow policies are collaborative, API-worker-only (`deepseek_only` in the MCP protocol), Codex-only and overnight review. Confirm the approved manifest, Git base, file/check scope, provider profile and budgets in Codex. Use `mosaic` to observe activity in another terminal. Press ↑ or ↓ to select an assignment, Enter to see bounded saved evidence, g to choose a goal, and q or Ctrl-C to close the observer. Approvals stay in Codex.

If the existing Mosaic coding core is installed in its standard user location, the terminal also discovers its read-only viewer connection. A chat using `frontier-harness` writes to that existing service; a chat using `mosaic-beta` writes to the separate beta service. The terminal labels the service it is watching, follows work when the current service is empty or another service becomes active, and retains the selected service when both have active work. Use `mosaic --source core` or `mosaic --source beta` to choose explicitly. No goals, approvals or settings are migrated between services. Older core versions load saved handoffs in bounded pages; the terminal shows a loading message while catching up. If the watched service disconnects, its last saved view stays visible as stale.

```sh
mosaic status --once
mosaic doctor
mosaic setup
mosaic uninstall
```

Doctor checks model discovery with the configured API worker. It does not send a completion. The status command also works when redirected to a file. Uninstall removes only owned, unchanged beta bindings and retains the beta versions, private settings and evidence. An existing non-beta launcher or MCP registration is preserved. Resolve active or prepared beta work in Codex before reconfiguring, updating or uninstalling. If a prepared worker-bound revision blocks maintenance, stop its goal and finalize it as partial in Codex to retire the revision. Setup can resume a saved, approved change after interruption. If you reinstall after uninstalling, open `mosaic` to restore the bindings with your retained settings.

For isolated local verification, use `./install --home /absolute/disposable/directory --no-path`. Put a fixture Codex executable under that directory, run `mosaic setup`, then start the isolated coordinator with `mosaic serve`. In this mode setup and doctor use a private fixture MCP registration. Host Codex registration and sign-in checks belong to a normal installation.

## Validation scope

On November 9, 2026, the Apple Silicon package `0.1.0-beta.102` (`fb368a1`) completed a live overnight coding task in an isolated home on the development Mac. The existing Spark service handled one planning request and one coding request. The protected check passed, Codex accepted the candidate in one independent review, and the coordinator integrated the change and finalized the goal. The fixture processes shut down after the run.

The full test suite passed 690 tests at `4372a38`. The beta and harness observer suites passed 26 tests at `f931136`, including the 20-column renderer change made after the live-tested build.

Setup and LaunchAgent registration on a separate clean macOS account or VM and a live hosted-provider coding task remain unverified.
