# Local candidate staging

This route composes the existing package builder, portable evidence verifier and
verified archive downloader. A completed staging report establishes exact byte
bindings. External qualification and release authority stay pending.

The public repository is an experimental source preview. Local staging produces
a candidate for a separately authorized disposable installation. A qualified
public release additionally needs current host/account and provider results,
owner-project quality, three independent workers, native network/Postgres,
clean-Mac and platform qualification, distribution review, publisher authenticity,
signing/notarization as selected, a trusted download channel and final acceptance.
Neither supplied acceptance text nor an integrity report closes these gates.

## Inputs and command

Use Node 24.22.0 on Apple Silicon macOS and an already installed npm on PATH.
Prepare the exact locked production dependency cache offline beforehand. Select
a canonical clean Git checkout at an explicitly reviewed commit and tree, a new
output directory outside every input, and a private owned writable npm cache.
All path arguments below are absolute except the optional verification reference.
Parents containing spaces, apostrophes, dollar signs and backticks are supported;
pass each value as one quoted argument.

```sh
"$PINNED_NODE" scripts/release/build-reviewed-candidate.mjs \
  --source "$SOURCE" \
  --expected-commit "$REVIEWED_COMMIT" --expected-tree "$REVIEWED_TREE" \
  --version "$VERSION" \
  --node "$ORDINARY_NODE" --node-sha256 "$ORDINARY_NODE_SHA256" \
  --node-license "$NODE_LICENSE" --node-license-sha256 "$NODE_LICENSE_SHA256" \
  --check-artifact "$NATIVE_ARTIFACT" \
  --native-manifest-sha256 "$REVIEWED_NATIVE_MANIFEST_SHA256" \
  --evidence-root "$EVIDENCE_ROOT" --evidence-records "$EVIDENCE_RECORDS" \
  --evidence-records-sha256 "$REVIEWED_EVIDENCE_RECORDS_SHA256" \
  --npm-cache "$OWNED_OFFLINE_CACHE" --output "$NEW_PRIVATE_OUTPUT"
```

Add `--verification-ref REPO_RELATIVE_PATH` only for an existing file in that exact
checkout. Its original builder semantics are unchanged: the candidate records
the digest of those source bytes. It is not proof that a command or test ran.

Use reviewed runtime and native-manifest pins from separately retained inputs.
The builder also retains its official coordinator Node/license pins and existing
native artifact/preflight checks. Before isolating the builder's HOME, the staging
parent applies the existing privacy helper to bounded native-node bytes with the
original owner-home context. The source is checked against raw Git blob
bytes and modes before any source tool executes, including edits hidden from Git
status by index flags. The existing verifier independently checks the completed
archive, source and supplied evidence. There is no moving branch, `latest`,
network resolver, fixture CLI override or inferred trusted digest.

`EVIDENCE_RECORDS` is a separately SHA256-pinned UTF-8 JSON file containing one
`records` array. Each record uses the existing portable verifier contract:

```json
{"records":[{"path":"review.json","sha256":"<64 lowercase hex characters>","bytes":123,"role":"review","scope":"source-fixture"}]}
```

Paths identify regular files under `EVIDENCE_ROOT`. Supported roles are
`acceptance`, `test-command`, `test-result`, `test-log`, `review`, `publication`;
scopes are `source-fixture`, `installed-fixture`, `live-claim`, `unknown`.
Use `{ "records": [] }` explicitly when there are no supplied records. Missing
or unsupported evidence does not become a test success: missing bytes/invalid
records reject verification, and an empty list reports acceptance as not supplied.
The orchestrator creates the existing evidence index only after the builder has
produced the exact candidate hash. Supplied claims remain unverified claims.

## Outputs and failure ownership

The output directory must not exist. It is created privately and is never reused
or overwritten. Outputs include:

- `build/mosaic-beta-VERSION-darwin-arm64.tar.gz`, its `.sha256` checksum and
  `.candidate.json` original schema1 metadata.
- `evidence-index.json`, bound to that exact candidate, archive, commit and tree.
- `reports/portable-evidence.json`, the existing sanitized integrity sidecar.
- `STAGING.json`, with exact hashes, required notice inventory records, unchanged
  original unpassed gates and a proposed downloader argv; `releaseAuthority:false`.
- `OWNER.json`, `STATUS.json` and bounded process ownership/result metadata.

`THIRD_PARTY_NOTICES.md` and `docs/DISTRIBUTION_PROVENANCE.md` are copied unchanged
into the runtime and its normal inventory. The former includes the additional
fdlibm/Sun/V8 source notices. These dated audit documents retain their historical
source/archive boundary and unresolved distribution findings. Inclusion does not
re-audit a later source, dependency closure or final binary. Existing Node notice
files, dependency license inventory, MIT attribution and native fingerprints are
preserved. After portable verification, a bounded data-only inventory read checks
the two required assets against their current source bytes and 0644 mode.

The builder and verifier each have a five-minute process deadline and a one-MiB
combined output ceiling. Metadata reads are bounded; ordinary Node is at most
256 MiB (also the native-node privacy read), archive 128 MiB, JSON/notices 2 MiB
and candidate metadata 1 MiB. The
data-only inventory command has a ten-second/two-MiB bound. These do not relax
the accepted builder/verifier/downloader limits. A timed-out/overproducing owned
detached process group receives TERM, then KILL after 500 ms if still present.
The runner drains for at most two seconds after stopping, including after leader
exit. An unproven group absence remains unresolved and prevents success. Ordinary
leader success with a surviving descendant also prevents success and retains its
ownership record.

Failures retain owned outputs and identify the failed phase. Raw child output
and environment are discarded rather than recorded; only allowlisted fixed
verifier reason codes and safe builder/npm classifications survive alongside
phase, exit/signal, byte count and process-group/quiescence metadata. npm uses separate
empty task-owned user/global configuration files, the supplied offline cache and
a task-owned short temporary root. The temporary root is retained even on success
and is named in ownership/status records. Inspect any unresolved owner before
retrying in a fresh directory or removing retained state. This workflow does not
delete runtime versions, holds, reservations, approvals or unrelated files.
Inputs must remain quiescent and access-controlled throughout; repeated pin
checks do not provide an atomic filesystem snapshot against a hostile writer.

## Separate download and disposable installation

The staging entry never serves, downloads, extracts to disk, installs or executes
archive code. First bind the resulting digest through an independently trusted
source and select an exact authorized HTTPS archive URL and disposable home.
Then run the accepted wrapper from the reviewed checkout:

```sh
/bin/sh "$SOURCE/distribution/archive/install.sh" \
  --version "$VERSION" --url "$EXACT_ARCHIVE_URL" \
  --sha256 "$INDEPENDENTLY_BOUND_ARCHIVE_SHA256" \
  --home "$DISPOSABLE_ABSOLUTE_HOME" --no-path
```

For an authorized local proof, an owned finite literal-loopback server may serve
the exact archive; add the wrapper's existing `--test-loopback-http` flag. The
wrapper checks the selected digest, version and archive structure before the
original installer runs. An archive checksum establishes byte identity; a checksum
obtained with an untrusted archive does not establish publisher authenticity.
No signing identity, public endpoint, quarantine bypass or release upload is
selected by this route. ROOT owns the serial combined build/install qualification
and must rebind the final integrated commit/tree and all affected inputs.

Focused source checks (no heavy candidate build):

```sh
node --test --test-concurrency=1 test/mosaic-release-staging.test.mjs \
  test/download-bootstrap.test.mjs test/portable-release-evidence.test.mjs
```

The new tests substitute the expensive builder with inert small specimens through
the module API and run the real verifier and bounded child executor. The existing
downloader tests prove invalid bytes do not execute an installer or alter an
unrelated target. These fixtures qualify no real archive, live host or provider.
