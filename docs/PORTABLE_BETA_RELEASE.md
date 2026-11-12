# Portable beta release evidence

Prepared November 12, 2026. This document describes a local Darwin arm64
release candidate and the evidence required to assess it. It does not authorize
publication or establish compatibility with a real host account or model.

## Candidate boundary

The archive contains the ordinary pinned Node 24.22.0 coordinator/bootstrap
runtime, the MCP SDK and its runtime dependencies, reviewed source, host
instructions, schemas/catalogs and license notices. Protected native checks use
a separate `runtime/check-artifact/` directory containing exactly `node`,
`mosaic-check-supervisor`, `NODE-LICENSE` and `artifact-manifest.json`. Its Node
24.22.0 has the reviewed libuv fork-path patch; an ordinary same-version Node
does not satisfy the native preflight. Native revision 1 remains unavailable.

New native approvals bind `darwin-seatbelt@2`, the manifest fingerprint and the
literal installed check executable path before goal hashing. Updates retain
artifacts referenced by resumable approvals. Relocating an archive does not
permit silently transplanting approved commands or recomputing saved hashes.
Uncertain supervisor ownership retains capacity, affected scope and maintenance
holds through service restart until exact quiescence or a positively new boot
is proven.

The candidate manifest records the source commit/tree and inventory/build
inputs. The package inventory independently binds bytes, sizes and executable
modes. A checksum establishes integrity; it is not a publisher signature.
Deterministic packaging of controlled pinned binaries does not prove that a
binary can be rebuilt identically on another toolchain.

New portable setup emits manual/unprobed registration instructions for every
real host, including Codex, because the supported interfaces do not provide
the required atomic comparison. The isolated fixture adapter is managed and
separately tested. Historical schema-1 Codex registration stays a compatibility
path; it is not evidence of safe real-host portable registration.

## Evidence levels

| Gate | Status for this stage | Evidence and limits |
|---|---|---|
| Accepted native source foundation | PASSED, historical stage 15 | Accepted source composition used real native checks, kernel probes, Chromium, Git, durable state and restart. Scripted loopback inference/review; no installed-release claim. |
| Stage 16 focused source tests | Pending final candidate verification | Setup, explicit migration, archive inventory, interruption, rollback and ownership tests must pass against the recorded candidate. |
| Disposable installed fixture | Pending actual execution | `test/mosaic-pb16-installed.test.mjs` requires named release and offline project artifacts. A source-only skip is not acceptance. |
| Final frozen full suite | Pending final candidate verification | Require the native backend, Chromium and installed fixture; retain exact command, source hashes, counts and failed attempts. |
| Fresh clean macOS account or VM | NOT RUN | Disposable homes on the development Mac do not establish a clean-machine install, toolchain prompts or login startup. |
| Actual Codex, Claude Code, Cursor and Antigravity versions/accounts | NOT RUN for this candidate | Public MCP SDK clients and configuration fixtures are not the corresponding applications. |
| Live two-provider coding/review task | NOT RUN | Loopback scripted responses establish protocol/state behavior, not model quality, provider limits or billing. |
| Signing, notarization and authenticated download channel | NOT RUN | Local unsigned artifacts and SHA-256 files only. |
| Public-source and complete license/distribution audit | NOT RUN | Included notices and an inventory are inputs to an audit, not legal clearance. |
| Public repository, registry or release publication | NOT RUN | No push, upload or publication is authorized by stage 16. |

## Installed fixture contract

The test extracts a real local candidate outside the source checkout under a
path containing spaces. Its bundled ordinary Node executes a copied test
driver. The driver loads the SDK from the installed version, starts the
installed CLI/service/MCP bridge and uses public tools for task, control,
review and integration mutations. It uses an empty disposable home, sanitized
PATH, dummy credentials and owned loopback endpoints. It does not import the
development source, use global modules, read developer authentication or inject
`checksFactory` or fake verification. Read-only SQLite inspection locates exact
persisted restart boundaries and the actual supervisor process.

The CSV sample's protected Chromium check stays byte-identical to the accepted
stage 15 fixture. The intended installed proof rejects the 44-byte all-rows CSV,
repairs it on its original pinned provider and accepts the exact 33-byte
selected-row download. It also exercises independent specialty work overlap,
shared capacity saturation, host closure with no API fallback, explicit API
review, malformed reviewer data, an unreachable worker, combined checked Git
integration and exactly-once replay. Saved-response, applied-edit, failed-check,
stopped-review and accepted replay boundaries use actual process restart. A
compatible second-version pointer update while the native approval is stopped
must retain its exact old artifact path, policy, goal hash and state. Final
maintenance also exercises `off`/`on`, source-free discovery, compatible rollback
and selective uninstall. An unresolved supervisor owner must block update and
uninstall despite its bounded child's exit. A
separate installed fixture deliberately loses its native supervisor and proves
that uncertainty, capacity and scope remain held after restart.
Its actual installation, SQLite and receipt paths remain retained even on
success. A consistent stopped database/receipt copy and hash inventory accompany
the evidence. Cleaning up the known bounded child does not clear its product
hold or authorize a replacement receipt.

The sample project's Playwright 1.64.1, Chromium headless-shell 1248 and ffmpeg
1013 files are a **separate offline test-project input artifact**, with a file,
mode, hash and upstream-license inventory. They are extracted into the
disposable project and copied through the normal approved dependency path.
They are not part of Mosaic's downloadable runtime. Neither the installed
service nor the checks may use a developer cache at execution. The test input
artifact hash and its explicit local build provenance accompany the run logs.

## Reproduction and handoff

Use [installation and recovery](PORTABLE_BETA_INSTALL.md) for the candidate's
ordinary commands. Build the companion input with
`test/fixtures/mosaic-pb16-installed/build-demo-input.mjs`, supplying explicit
pinned module and accepted browser directories and a new output tar path.
The local handoff records those input paths; no machine-specific path belongs
in a release artifact.

Run the installed gate with explicit artifacts:

```sh
MOSAIC_REQUIRE_INSTALLED=1 \
MOSAIC_INSTALLED_ARCHIVE=/absolute/local-candidate.tar.gz \
MOSAIC_INSTALLED_UPDATE_ARCHIVE=/absolute/next-compatible-version.tar.gz \
MOSAIC_INSTALLED_DEMO_ARCHIVE=/absolute/offline-project-inputs.tar.gz \
MOSAIC_INSTALLED_ROOT_PARENT=/absolute/owned-durable-fixtures \
MOSAIC_INSTALLED_EVIDENCE_DIR=/absolute/owned-evidence \
node --test --test-concurrency=1 test/mosaic-pb16-installed.test.mjs
```

Required tests fail when their actual platform, runtime or browser inputs are
absent. Logs identify the exact phase, archive/input hashes and preserved
failure state. Final acceptance must map each D1–D9 criterion to concrete
evidence on the reviewed source tree; test counts alone are insufficient.
Archive paths/hashes, inventory, independent review and remaining gates belong
in the local stage 16 handoff. `ready_for_review` means a local candidate ready
for review, not a public release.
