# Portable candidate evidence verifier

`scripts/release/verify-portable-candidate.mjs` binds an existing portable
candidate to archive bytes, an exact clean source checkout and explicitly
supplied evidence records. It writes a separate sanitized schema-1 sidecar
described by
[`portable-evidence.schema.json`](../scripts/release/portable-evidence.schema.json).
It does not change the [builder's candidate schema](../scripts/lib/beta-candidate.schema.json),
the candidate, its gate labels or the package inventory.

Exit `0` means the supported byte and evidence bindings passed. It never means
the product is ready for release. Hashes do not prove that a test ran, a reviewer
is trusted, a model works or a publisher is authentic. This verifier does not
extract or execute archive members, run builds/tests/installers, contact providers
or a network, inspect personal installations or scan task/database state. Its
only child commands are bounded, read-only Git queries against `--source`.

## CLI

Use a trusted Node runtime. Prepare an existing, current-user-owned report
directory with no group or other permissions, separate from every input. All
paths below are placeholders; substitute explicit local paths.

```sh
node scripts/release/verify-portable-candidate.mjs \
  --candidate /absolute/inputs/candidate.json \
  --archive /absolute/inputs/mosaic-beta-0.1.0-beta.1-darwin-arm64.tar.gz \
  --source /absolute/source-checkout \
  --evidence-root /absolute/evidence \
  --evidence-index /absolute/evidence/index.json \
  --report-dir /absolute/private-reports \
  --output /absolute/private-reports/portable-evidence.json \
  --expected-commit 0000000000000000000000000000000000000000 \
  --expected-tree 1111111111111111111111111111111111111111
```

The last two flags are optional extra pins: lowercase 40-character Git object
IDs. The checkout must always match the candidate's commit and tree, even when
these flags are absent. Every other flag is required exactly once. `--help` alone
prints usage. Exit `2` rejects input or output with one finite error code and no
input paths or record contents. Failed verification emits no report.

The output must be a new direct child of `--report-dir`. The CLI creates only
that file, mode `0600`, with exclusive creation; it does not create directories
or overwrite an existing file. The output basename uses the same bounded safe
relative-path character rules as record paths. The report directory must not overlap the source,
evidence root/index, candidate or archive. Input path components must exist and
must not be symlinks; `..` components and control characters are rejected.
Files must be regular files. On macOS the usual `/tmp` and `/var` aliases are
normalized to their `/private` paths before checking.

## Supported schema-1 profile

The verifier deliberately accepts a strict subset of possible candidate JSON:
`mosaic-portable-beta-candidate`, `darwin-arm64`, clean source, a bounded dotted
version, the matching versioned archive filename, and the fixed
`payload/package-manifest.json` inventory path. Unknown candidate fields are
rejected recursively. It accepts `terminal-beta-v1` and `terminal-beta-v2`
inventories, with their corresponding absent/present native check claims. A
native claim must bind `darwin-seatbelt@2` and check Node `24.22.0`; checking those
immutable builder claims does not rerun the native preflight. Unsupported
profiles fail closed rather than changing an older candidate.

The archive must match the candidate digest and canonical `ustar-gzip-v1`
inventory: ordered unique safe paths, only regular files/directories, declared
sizes and modes, zero owner/group/timestamps, canonical headers/padding and an
exact member set. The inventory digest, canonical content hash, checksum list,
runtime source closure, required runtime inputs, SDK version and supported native
metadata must agree. Build inputs, verification references and corresponding
packaged source/license/docs/provenance bytes are bound to the checkout.
The complete packaged runtime source path list must equal the bounded closure
derived from the tracked CLI's relative `.mjs` imports, tracked workflow
definitions and native supervisor source.

The source path must be the checkout root. HEAD commit/tree, every indexed
stage-0 path/blob/mode and every tracked working-file byte/executable bit must
match. Nonignored untracked files are rejected; ignored files are outside the
source cleanliness claim. Git symlinks, submodules and unsupported file modes
are rejected. Git queries disable optional locks, filesystem monitoring,
untracked caching, Git replacement objects and global/system configuration.

## Evidence index

Supply an explicit index file; it may live outside `--evidence-root` so an index
can refer to an existing immutable evidence directory without writing there.
Record paths always resolve beneath `--evidence-root`. The index's exact fields
are shown below; there are no optional fields or additional properties,
including in nested objects. Replace the placeholder digests and IDs with actual
byte hashes and lengths.

```json
{
  "schema": 1,
  "kind": "mosaic-portable-evidence-index",
  "binding": {
    "candidateSha256": "<64 lowercase hexadecimal characters>",
    "archiveSha256": "<64 lowercase hexadecimal characters>",
    "sourceCommit": "<40 lowercase hexadecimal characters>",
    "sourceTree": "<40 lowercase hexadecimal characters>"
  },
  "records": [
    {
      "path": "acceptance.json",
      "sha256": "<64 lowercase hexadecimal characters>",
      "bytes": 123,
      "role": "acceptance",
      "scope": "source-fixture"
    }
  ]
}
```

All four bindings must match the supplied candidate/archive/source exactly.
Candidate and index hashes cover their raw JSON bytes, including formatting.
Records may be empty. Each record path must be unique, relative to the evidence
root and composed of printable ASCII, at most 255 bytes and 32 components, with
no empty, `.`, `..`, backslash or colon components. Absolute paths are rejected.
Each referenced file's byte count and SHA-256 must match. Records are opaque
bytes; arbitrary JSON success claims and transcript text receive no authority.

| Field | Accepted values |
|---|---|
| `role` | `acceptance`, `test-command`, `test-result`, `test-log`, `review`, `publication` |
| `scope` | `source-fixture`, `installed-fixture`, `live-claim`, `unknown` |

These labels are supplied descriptions. The sidecar preserves them, labels
`live-claim` as `unverified-claim` and every other scope as `supplied-only`.
An acceptance role yields only `localAcceptance: supplied-unverified`. A
publication role yields only `publication: supplied-dated-record-only`; a dated
record may describe source availability, but the verifier does not establish its
date, check a URL now or qualify any download. Missing roles are `not-supplied`.

## Finite limits and read model

MiB means 1,048,576 bytes. These are rejection ceilings, not resource reservations.

| Input or operation | Limit |
|---|---:|
| Candidate JSON | 1 MiB |
| Index and each parsed archive metadata JSON | 2 MiB |
| Compressed archive | 128 MiB |
| Expanded archive stream | 512 MiB |
| One archive member | 256 MiB |
| Archive entries / inventory records | 10,000 each |
| Evidence records | 64 |
| One evidence record | 8 MiB |
| Index bytes plus declared evidence record bytes | 64 MiB |
| One tracked source file / all tracked source bytes | 16 MiB / 128 MiB |
| Tracked source files | 10,000 |
| Each Git query | 10 seconds; 4 MiB output |
| Parsed JSON nesting / lexical complexity counter | 20 levels / 300,000 steps |

JSON must be valid UTF-8 with no duplicate object keys. The parser bounds both
size and nesting before parsing. Archive hashing/inventory inspection streams
in bounded chunks; it retains only selected bounded metadata, not extracted
files. Source and evidence files use bounded regular-file reads with descriptor
and path metadata checks. Source is checked again, and the candidate is reread,
before producing the sidecar.

Keep all inputs and their parent directories unchanged for the entire run.
The verifier does not lock inputs or take a filesystem snapshot. Its repeated
reads and metadata checks detect observed changes; they do not guarantee a
single atomic view against concurrent or adversarial path replacement, or that
an input stays unchanged after it has been checked. Use a quiescent, access
controlled checkout and evidence directory. The source check covers tracked
files and nonignored untracked paths within this bounded profile.

## Sidecar and release boundary

Public sidecar data is allowlisted: fixed logical filenames, digests, byte/file
counts, source IDs, candidate version/platform/fixture flag, supplied enums and
fixed findings. Evidence paths become `record-001` through `record-064` in index
order. No original evidence filename, absolute path, endpoint, credential, raw
record text, task prompt, terminal transcript or database content is copied.
The candidate's controlled archive basename and inventory path remain portable.
Keep detailed input mappings and diagnostic records in a separate private
handoff; the sidecar does not contain them.

`candidate.originalUnpassedGates` copies the immutable candidate's labels without
removing, renaming or clearing them. The sidecar always has
`releaseAuthority: false`, `authenticity: not-established` and
`readiness: pending-external-qualification`. Its separate external gates all
remain `pending`: actual host discovery, real owner-project quality, live model
quality, three independent workers, native network/Postgres, clean Mac, other
platforms, signing/notarization, authenticated public download and final beta
acceptance. Supplied local acceptance, source/installed fixtures, large test
counts and source publication do not close those gates. Two distributed model
machines do not by themselves establish three independently addressable workers.

See [portable release evidence](PORTABLE_BETA_RELEASE.md) for the broader
candidate and installed-fixture boundaries. This offline sidecar supplies a
review input; separate qualified evidence and an authorized release decision
are still required.
