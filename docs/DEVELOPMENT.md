# Development setup

Use a Git checkout and Node.js **24.22.0**. The package engine expression is `>=24.22.0 <25`; this declares the supported development line, while 24.22.0 is the verified baseline and the version pinned in source CI. It does not claim every later patch was tested. Node 20 is insufficient: the coordinator directly imports `DatabaseSync` from `node:sqlite`, and deployment checkpoint code imports SQLite `backup`. Do not substitute the bundled fork-only native check runtime for the development Node executable.

Portable source development also needs Git, Python 3, a POSIX shell, normal file permissions and symlink support. Linux/macOS provide the process signals and utilities used by fixtures (`tar` and `mkfifo`). Windows native shells are outside this profile. Ubuntu source CI checks the Linux environment; a local Mac result establishes only that Mac environment.

## Prepare dependencies

Check the runtime before installing:

```sh
node --version
npm --version
git --version
python3 --version
npm ci --ignore-scripts --no-audit --no-fund
```

`npm ci` consumes the committed lockfile and recreates `node_modules`. Lifecycle scripts are disabled. Do not use `npm install` to refresh versions while fixing unrelated code. Playwright and the MCP SDK stay pinned by the repository. A browser binary is unnecessary for the portable profile.

For a prepared offline environment, use your own writable cache populated from the same lockfile:

```sh
npm ci --offline --ignore-scripts --no-audit --no-fund --cache /absolute/contributor-owned/npm-cache
```

A missing cached dependency is a preparation failure. Do not silently upgrade a dependency or drop `--offline`. The project owner's private caches and acceptance artifacts are not contributor prerequisites.

## Run a fake handoff

```sh
npm run demo -- "Explain a small change"
```

This uses fake local/frontier adapters and writes a disposable job under the checkout's ignored `.data` directory. It demonstrates the handoff and event log without a host login, API key or external inference. The terminal approval variant is:

```sh
npm run live -- --brief examples/design-brief.md --fake
```

That variant asks for plan approval interactively. Live operation needs separate explicit configuration and consent; see [the first milestone](MVP.md) and [terminal beta guide](TERMINAL_BETA.md).

## Source map

| Path | Responsibility |
| --- | --- |
| `src/harness/` | Coordinator state, tools, workflows, provider routing and durable evidence |
| `src/project/` | Project permissions, workspaces, execution backends and checks |
| `src/beta/` | Portable Mac setup, settings, service and terminal observer |
| `src/adapters/` | Fake and external model adapters for the original terminal workflow |
| `scripts/` | Source utilities, fixture demonstrations and separately qualified packaging tools |
| `test/` and `test/project/` | Direct `.test.mjs` entry files |
| `test/fixtures/` | Drivers and inputs invoked by their owning tests, never discovered as entries |
| `.agents/skills/` | Versioned workflow guidance and launcher sources |
| `docs/` | Product, development and qualification documentation |

Start with [product context](PRODUCT_CONTEXT.md), then [testing](TESTING.md). Keep source mechanisms, scripted fixture results and actual host/model evidence distinct. The [portable beta release record](PORTABLE_BETA_RELEASE.md) describes broader qualification; source CI does not close those gates.
