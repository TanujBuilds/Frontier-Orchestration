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

```sh
mosaic status --once
mosaic doctor
mosaic setup
mosaic uninstall
```

Doctor checks model discovery with the configured API worker. It does not send a completion. The status command also works when redirected to a file. Uninstall removes only owned, unchanged beta bindings and retains the beta versions, private settings and evidence. An existing non-beta launcher or MCP registration is preserved. Resolve active or prepared beta work in Codex before reconfiguring, updating or uninstalling. If a prepared worker-bound revision blocks maintenance, stop its goal and finalize it as partial in Codex to retire the revision. Setup can resume a saved, approved change after interruption. If you reinstall after uninstalling, open `mosaic` to restore the bindings with your retained settings.

For isolated local verification, use `./install --home /absolute/disposable/directory --no-path`. Put a fixture Codex executable under that directory, run `mosaic setup`, then start the isolated coordinator with `mosaic serve`. In this mode setup and doctor use a private fixture MCP registration. Host Codex registration and sign-in checks belong to a normal installation.

## Validation scope

This is a private terminal beta. Local tests use isolated directories, fixture Codex registrations, and local HTTP responses. Release validation still requires a separate clean macOS account or VM, an actual Spark coding task, a hosted-provider coding task and a real Codex review. Research remains parked.
