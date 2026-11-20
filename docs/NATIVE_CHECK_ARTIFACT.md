# Native check runtime artifact

Darwin arm64 backend revision 2 uses a separate Node build and the trusted C supervisor. New release artifacts use Node 24.22.3. Previously approved Node 24.22.0 artifacts retain their original implementation and fingerprint. The coordinator keeps its ordinary Node runtime. Revision 1 remains unavailable. Building the artifact leaves installation and approval state untouched.

The build script packages explicitly supplied local material. It does not download
Node, build Node, install dependencies or accept worker-generated C/flags. It
compiles only `src/project/check-backends/native-supervisor.c` using
`/usr/bin/clang -std=c11 -O2 -Wall -Wextra -Werror`. Build output must be a fresh
folder below a canonical, owned, non-group/world-writable parent. Failures remove
only the fresh output created by that invocation; existing output is never replaced.

## Build the check-only Node

Use an isolated developer build directory, the Apple command-line toolchain and
the official [Node 24.22.3 source archive](https://nodejs.org/dist/v24.22.3/node-v24.22.3.tar.xz).
Its SHA-256 is `48ca3aa8a9b02133356922ef4fc80200e00598c80a4ef446f7c39a459222593d`.
Verify the signed checksum using [the Node.js release keys](https://github.com/nodejs/release-keys). Preserve the complete source `LICENSE` and the supplemental texts indexed in `distribution/notices/INDEX.md`. The archive includes this index at `payload/runtime/notices/INDEX.md`.

The reviewed patch is
`test/fixtures/mosaic-pb15-v2-composition/fork-only.patch`, SHA-256
`840109e32a582faf92ed07f75987c6eb03c9b5659cf74b2f5231ac1e72594741`.
It disables libuv's Apple `posix_spawn` branch **before** file-action mutations,
using the existing fork implementation. Kernel denial of `setsid`, `setpgid` and
`posix_spawn` supplies containment; the Node patch alone does not.

From the extracted source directory, apply that exact patch with `patch -p1`, then
run `./configure` and `make -j4`, retaining both logs and the compiler version.
The input runtime is `out/Release/node`. Independently verify that the source
archive differs only at `deps/uv/src/unix/process.c`, then run the real native
spawn, escape, cleanup and Chromium gates. Qualify the exact patched binary through the spawn isolation preflight. The same-version stock runtime fails that preflight.

## Package local verified inputs

Resolve all input paths before invoking the builder. The example uses shell
variables for developer-owned paths; none are model-controlled task data.

```sh
node scripts/build-native-check-artifact.mjs \
  --built-node "$NATIVE_BUILD/out/Release/node" \
  --built-node-sha256 "$VERIFIED_NODE_SHA256" \
  --node-license "$NATIVE_BUILD/LICENSE" \
  --patch-file "$MOSAIC_SOURCE/test/fixtures/mosaic-pb15-v2-composition/fork-only.patch" \
  --output "$PRIVATE_ARTIFACT_PARENT/new-artifact"
```

The output contains exactly `node` (0755), `mosaic-check-supervisor` (0755),
`NODE-LICENSE` (0644), and `artifact-manifest.json` (0600). The directory is 0700.
The manifest has this fixed schema:

```json
{
  "schema": 1,
  "platform": "darwin",
  "arch": "arm64",
  "nodeVersion": "24.22.3",
  "supervisorProtocol": 1,
  "files": [
    {"path": "node", "sha256": "<64 hex>", "bytes": 0, "mode": "100755"},
    {"path": "mosaic-check-supervisor", "sha256": "<64 hex>", "bytes": 0, "mode": "100755"},
    {"path": "NODE-LICENSE", "sha256": "<64 hex>", "bytes": 0, "mode": "100644"}
  ],
  "provenance": {
    "nodeSource": {"version": "24.22.3", "url": "<official archive URL>", "sha256": "<archive hash>"},
    "nodePatch": {"sha256": "<patch hash>", "description": "<patch purpose>"},
    "supervisorSourceSha256": "<trusted C source hash>",
    "build": {"compiler": "<clang version and literal flags>", "platform": "darwin-arm64"}
  }
}
```

The example sizes/hashes are placeholders, not a valid artifact. The builder
hashes actual file bytes, checks the explicit Node hash, probes the runtime
version/platform, and rechecks build inputs after compilation/copying. Source
provenance documents the independently verified build; it cannot infer a binary's
source from a version string. Repeating the packaging step with identical inputs,
source and toolchain produces the same manifest bytes and fingerprint.

The artifact fingerprint is SHA-256 of the exact manifest bytes, including its
trailing newline. There is no self-reference or timestamp. Private trusted
configuration names the canonical manifest and its fingerprint:

```json
{"schema":1,"artifactManifestPath":"<canonical private artifact>/artifact-manifest.json","artifactManifestSha256":"<manifest SHA-256>"}
```

This object is the `nativeCheckRuntime` setting. A fresh approval explicitly uses
`{version:1, backend:'darwin-seatbelt', backendRevision:2,
runtimeFingerprint:'<same manifest SHA-256>'}`. Prepare each check with the
artifact's absolute `node` path in its saved literal argv. The trusted
[native runtime dispatcher](../src/project/check-backends/native-runtime-dispatch.mjs) provides `nativeCheckArgv` to produce that vector for either supported artifact. Execution never
rewrites a previously approved stock Node path. Public goal data cannot supply
artifact paths, factories, policies or compiler arguments.

The backend revalidates canonical paths, ownership, modes and hashes at authority
boundaries. Native verification uses the actual factory, supervisor and runtime;
missing, changed or same-version stock artifacts fail before inference dispatch.
A stopped or uncertain owner retains its original approval, spending and deadline.
The private supervisor receipt, not process output or elapsed time, proves that
an owned check is quiescent.

## Required local verification

Set `MOSAIC_NATIVE_TEST_NODE` to the independently built fork-only runtime. The
license defaults to its source tree's `LICENSE`, or set
`MOSAIC_NATIVE_TEST_LICENSE` explicitly. Tests compile their own current helper
and copy the supplied Node into private canonical temporary directories; they
never execute it from credential/source storage or replace the coordinator Node.

```sh
MOSAIC_REQUIRE_NATIVE=1 MOSAIC_REQUIRE_BROWSER=1 \
MOSAIC_NATIVE_TEST_NODE="$NATIVE_BUILD/out/Release/node" \
node --test --test-concurrency=1 \
  test/native-artifact.test.mjs test/mosaic-pb15-native-v2-composition.test.mjs
```

Required mode fails when the runtime/platform is unavailable. Contributor mode
may skip explicitly unavailable native tests. The composition suite removes
Codex from PATH, scripts only loopback worker/reviewer responses, and exercises
real protected checks, unchanged Chromium CSV assertions, routed bounded repair,
host/API review, restart retention and serialized integration. These fixtures do
not establish model quality or a live account/provider integration.

The Node/license artifact remains local developer output. Stage 16 owns final
archive inclusion, executable modes, installation, source/license distribution,
and installed-host verification. No package builder or installer is changed by
this Stage 15 builder. No clean-machine, other-platform, signing or notarization
claim follows from these local checks.
