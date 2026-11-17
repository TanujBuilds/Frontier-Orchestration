# Test selection and qualification

Run commands from the repository root with development Node **24.22.0** and exact-lock dependencies prepared as in [development setup](DEVELOPMENT.md).

## Portable source checks

```sh
npm run test:source -- --list
npm run test:source
# npm test is the same portable profile
npm test
```

`--list` prints JSON containing the profile, sorted selected entry paths, and separately qualified paths with reasons. It does not run tests or validate qualification inputs. The runner enumerates only immediate regular `.test.mjs` files in `test/` and `test/project/`. It includes current new entries at those roots. It ignores symlink entries, subdirectories, fixture drivers and helper `.mjs` files. Review the inventory when adding tests or integrating branches; a new capability-specific test needs an explicit classification in `scripts/test-source.mjs`.

The portable profile runs source contracts and scripted/injected or owned loopback fixtures. Whole files containing Darwin native execution, macOS PTY/filesystem checks, actual Chromium, offline standalone-runtime builds or installed release lifecycles are separately qualified. A fixture provider can still lead to real Darwin execution through the default check runner; those composition files are also separate. Some files mix source assertions with those gates; their source assertions also remain in the separate profile. Excluded files are reported, never presented as passing tests or hidden skips.

Unset qualification variables before a portable run. The runner rejects nonempty `MOSAIC_REQUIRE_*`, `MOSAIC_NATIVE_*`, `MOSAIC_INSTALLED_*`, `MOSAIC_FEASIBILITY_*`, `MOSAIC_THREE_WORKER_*` and `PLAYWRIGHT_BROWSERS_PATH` inputs so an inherited environment cannot activate a native/installed path. Both profiles reject nonempty `NODE_OPTIONS` to prevent hidden filtering or preload changes. Symlinked entry roots are rejected. Tests run sequentially as an explicit literal argv list using the current Node binary, with the TAP reporter. Child failure fails the command; SIGINT/SIGTERM cancellation stays cancellation. No entries is an error.

For a focused source iteration, use a literal name pattern, including spaces:

```sh
npm run test:source -- --test-name-pattern 'provider discovery'
# Or select an affected entry explicitly:
node --test --test-concurrency=1 test/test-source-runner.test.mjs
```

A filtered run is partial evidence, even if it exits successfully. The required Darwin profile prohibits filtering. Unknown profiles/options and missing pattern values fail before execution. Do not use bare `node --test`: recursive discovery can execute fixture drivers as independent tests.

Only the portable test child receives fallback Git author and committer metadata (`Mosaic source fixtures <fixture@example.invalid>`) for disposable fixture commits. Explicit `GIT_AUTHOR_*` and `GIT_COMMITTER_*` values are preserved. The runner leaves Git configuration files unchanged, so portable tests can run without a personal Git identity.

## What GitHub CI proves

[The source workflow](../.github/workflows/source-checks.yml) runs on Ubuntu 24.04 with Node 24.22.0, exact-lock `npm ci --ignore-scripts`, an inventory report and `npm run test:source`. Actions are pinned to full immutable upstream commit SHAs. The workflow has read-only repository permissions, no retained Git credentials, a finite timeout and no publishing steps.

A green run establishes that the reported portable selection passed in that GitHub runner at that commit. It does not establish Darwin sandbox containment, an installed Chromium lifecycle, actual coding-host discovery, live provider quality, three independent real model endpoints, clean-Mac installation or a public binary release. A workflow file alone is not a successful CI run. Local and GitHub results should be reported separately.

## Required Darwin qualification

```sh
npm run test:darwin -- --list
# Only after preparing and verifying every qualification input:
npm run test:darwin
```

This profile selects **all** current direct entries at both roots, including the portable entries. It requires Darwin arm64, fails early when the native/browser/installed inputs below are absent, and sets all three strict flags to `1`: `MOSAIC_REQUIRE_NATIVE`, `MOSAIC_REQUIRE_BROWSER`, `MOSAIC_REQUIRE_INSTALLED`. Existing test assertions still check the real bytes, runtime and policy; presence preflight is not certification. Never replace a required input with stock Node, mocked execution or a missing-prerequisite skip.

The required profile adds no Git identity fallback. Required qualification includes N1's strict environment guard: every `GIT_*` variable except `GIT_PAGER` must be absent, including author/committer and Git-config overrides. Caller overrides are preserved and rejected by that guard, rather than silently removed. Required fixtures that make commits need an existing normal per-user Git identity readable by their disposable repositories; a checkout-local identity alone may not reach them. Verify `git var GIT_AUTHOR_IDENT` and `git var GIT_COMMITTER_IDENT` in a disposable repository using the qualification user's normal configuration. The runner does not configure Git. Do not satisfy this prerequisite with identity/config override environment variables.

| Input | Required meaning |
| --- | --- |
| `MOSAIC_NATIVE_TEST_NODE` | Absolute executable path to the independently built, verified fork-only check Node |
| `MOSAIC_NATIVE_TEST_LICENSE` | Readable native Node license; optional only when the existing runtime-relative `../../../LICENSE` fallback exists |
| `MOSAIC_NATIVE_ARTIFACT_MANIFEST`, `MOSAIC_NATIVE_ARTIFACT_SHA256` | Exact native manifest path and lowercase SHA256, used by N1 feasibility checks |
| `MOSAIC_FEASIBILITY_TEST_PARENT` | Existing owned neutral directory for N1 proofs |
| `MOSAIC_THREE_WORKER_NATIVE_MANIFEST`, `MOSAIC_THREE_WORKER_NATIVE_SHA256` | Exact native manifest path and lowercase SHA256 for W1 rehearsal |
| `MOSAIC_THREE_WORKER_TEST_PARENT` | Existing owned neutral directory for W1 proofs |
| `MOSAIC_INSTALLED_ARCHIVE` | Independently inventoried primary Darwin arm64 archive |
| `MOSAIC_INSTALLED_UPDATE_ARCHIVE` | Independently inventoried compatible update archive with a distinct version |
| `MOSAIC_INSTALLED_DEMO_ARCHIVE` | Separately inventoried offline project/dependency archive |
| `MOSAIC_INSTALLED_ROOT_PARENT` | Existing owned durable neutral directory outside the source checkout for extracted proofs |

Prepare the **lockfile-pinned headless shell** in the repository cache, in an environment authorized for browser downloads:

```sh
PLAYWRIGHT_BROWSERS_PATH="$PWD/node_modules/.cache/ms-playwright" npx --no-install playwright install --only-shell chromium
```

For the pinned Playwright1.64.1 Darwin arm64 contract, required preflight checks `node_modules/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell`, matching N1 and the protected checks. It checks presence/readability/executability only; later qualification validates the actual bytes and policy. The full Chromium application or a user-global browser cache cannot substitute. `PLAYWRIGHT_BROWSERS_PATH` does not redirect this required repository prerequisite; protected execution also supplies the repository cache. Native qualification additionally needs the real Darwin sandbox tools, compiler, the configured Codex sandbox executable for legacy checks, full source Git history, and an exact-lock offline npm cache for tests that construct standalone runtimes. These are separate from portable dependency preparation; do not grant sandbox permissions or build/download runtimes merely to make source CI green.

Set `MOSAIC_NATIVE_EVIDENCE_DIR` and `MOSAIC_INSTALLED_EVIDENCE_DIR` to owned evidence directories when collecting qualification. Preserve failed logs, exact input hashes, retained uncertain execution roots, approvals, counters and deadlines. Tests deliberately retain roots when ownership remains uncertain. Do not clear those holds or force-delete roots as cleanup.

The accepted full-suite contract includes the N1 **and** W1 inputs above alongside native, browser and installed inputs. A coordinator performs combined qualification serially after source integration, with freshly bound source/tree and all new entry files inventoried. Passing this command remains fixture/native/package evidence; real hosts, model work and clean-Mac/download gates need their own observed results. See [portable beta release evidence](PORTABLE_BETA_RELEASE.md), [host compatibility](HOST_COMPATIBILITY.md), and [native feasibility](NATIVE_APP_FEASIBILITY.md).
