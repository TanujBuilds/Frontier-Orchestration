# Verified archive installation prototype

This source prototype downloads an explicitly selected Mosaic Mac arm64 archive,
checks an independently trusted SHA256, validates its archive structure and selected
version, then runs that archive's existing installer. Installation needs no
preinstalled Node: it uses macOS `/bin/sh`, `/usr/bin/perl` (core Digest::SHA,
JSON::PP and IO::Uncompress::Gunzip modules), `/usr/bin/curl` and `/usr/bin/uname`.
The package supplies Node for the original installer and launcher. Availability on
a clean Mac still needs qualification.

The repository is an experimental source preview. There is no qualified public
binary download channel specified here. Obtain the wrapper from a trusted source
revision and obtain an exact archive URL, version and digest separately; this
prototype invents no endpoint and resolves no `latest` version.

Set the four values explicitly, then run from the repository root:

```sh
/bin/sh distribution/archive/install.sh \
  --version "$MOSAIC_VERSION" --url "$MOSAIC_ARCHIVE_URL" \
  --sha256 "$MOSAIC_TRUSTED_SHA256" --home "$MOSAIC_TARGET_HOME" --no-path
```

With those values and an absolute target home selected:

```sh
/bin/sh distribution/archive/install.sh \
  --version "$VERSION" \
  --url "$ARCHIVE_URL" \
  --sha256 "$TRUSTED_SHA256" \
  --home "$TARGET_HOME" \
  --no-path
```

All four value arguments are required. `TARGET_HOME` selects an explicit isolated
installation home, which may contain spaces or an existing Mosaic installation.
The wrapper has no default target. Versions have the package builder's exact
`X.Y.Z` or `X.Y.Z-beta.N` form. Production URLs require HTTPS without embedded
credentials or fragments; query strings are accepted but omitted from wrapper
diagnostics. Requests use direct connections with curl configuration and proxies
disabled. No sudo is needed.

`--version`, `--url` and `--sha256` belong to this wrapper. Only `--home` and the
optional `--no-path` reach the packaged `install` entry point. With `--no-path`,
use `TARGET_HOME/.local/bin/mosaic` directly. Omitting it lets the existing
installer apply its normal PATH guidance/consent behavior. The wrapper does not
run setup, start provider diagnostics or select a model.

## What is verified

A SHA256 supplied through an independently trusted source checks that the selected
bytes match that digest. A checksum fetched alongside an untrusted archive does
not authenticate its publisher. HTTPS supplies transport security; the checksum
and archive parser establish neither publisher identity nor signing/notarization.
After verification, the selected installer is executable code from that trusted
archive. Trust in the wrapper and the source of the expected digest is necessary.

The wrapper checks Darwin arm64 before downloading and checks the digest before
extraction or archive code execution. It accepts the existing builder's narrow
ustar/gzip format under exactly `mosaic-beta-VERSION-darwin-arm64/`, validates the
manifest's version/layout, and rejects traversal, absolute/ambiguous paths,
duplicates, symlinks, hardlinks, devices, other special entries and extensions.
Extraction creates new files in private staging and never overlays the target.

Download and inspection limits are fixed:

- One 120-second download deadline across at most three redirects, with a
  256-MiB total response-body ceiling, including redirect bodies.
- A 64-KiB cumulative HTTP header budget. Each redirect URL passes the same
  protocol/authority checks before another request.
- A 120-second archive inspection/extraction deadline, at most 1 GiB expanded
  bytes (including tar headers/padding), 20,000 entries and 256 MiB per file.
- Fixed gzip headers without optional metadata, bounded tar headers and a
  2-MiB manifest read. The installer entry is at most 64 KiB and its checksum
  list at most 4 MiB. Trailing data and additional gzip streams are rejected.

The original installer then verifies its package inventory and preserves its
native-runtime, retained-version, ownership, locking and recovery rules. See
[installation and recovery](../docs/PORTABLE_BETA_INSTALL.md) and
[release gates](../docs/PORTABLE_BETA_RELEASE.md).

## Failure and recovery

Download, checksum and archive validation failures execute no installer and make
no target changes. Owned quiescent staging is removed. Diagnostics identify the
failed phase without printing response bodies, URL credentials or queries.

The wrapper waits up to 180 seconds for the original installer. On interruption,
timeout or unresolved installer process-group ownership it preserves staging and
reports the ownership identifier and staging path. Installation may still be
running; inspect the reported owner and target recovery state before retrying or
removing staging. It does not kill a maintenance process tree, delete installed
runtimes or override the installer's recovery transaction. An installer failure
may have its own recovery state; follow the existing installation guide.

The wrapper does not remove quarantine, bypass Gatekeeper, sign/notarize bytes,
publish assets or qualify browser download/clean-Mac behavior.

## Maintainer fixtures

Run the focused source tests with Node 24:

```sh
node --test test/download-bootstrap.test.mjs
/bin/sh -n distribution/archive/install.sh
```

Tests use owned loopback servers and small archive specimens, plus a bounded
compressed-bomb specimen and an actual 120-second deadline test. System-host
rejection is simulated with test-only wrapper copies; there is no production
platform override. `--test-loopback-http` allows HTTP only to literal `127.0.0.1`
or `[::1]` for controlled fixtures, including redirects. It preserves all digest,
archive, version, platform and installer checks. It is not a public HTTP channel.

For a separately authorized staged proof, the fixture driver
`test/fixtures/download-bootstrap/staged-proof.mjs` takes an accepted-input JSON
file, evidence directory and owned disposable proof parent. It verifies the
input archive and candidate metadata pins before serving the existing beta184
archive on loopback. It installs via this wrapper, checks the shipped launcher
with system-only PATH, reads receipts with bundled Node, exercises installed
native validation with persisted ownership, and checks existing-target/runtime
preservation. Its logs and retained disposable roots are private evidence.
This proves the staged path on the test Mac; public authenticity, browser
quarantine, clean-Mac and broader release qualification remain separate.
