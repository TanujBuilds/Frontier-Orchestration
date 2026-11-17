# Changelog

This file tracks source checkpoints. Local archive version labels are not published releases. The repository is an experimental MIT source preview; no qualified binary release is declared here.

## Unreleased

- Checkpoint documentation follows verified acceptance; later source changes require their own qualification.

## Source checkpoint — November 17, 2026: owner workflow foundation

Commit [`202338e0a143fef4150d1cca3ccdb49661778890`](https://github.com/TanujBuilds/Mosaic/commit/202338e0a143fef4150d1cca3ccdb49661778890), tree `017013b441fe62ed2e2744d2050731069ac74964`. Accepted on November 17 for source, owned native/browser fixtures and disposable installed-package composition, with the source checkpoint verified on GitHub. This is the latest checkpoint documented here. The earlier November 17 and November 16 records below preserve their original revisions and scope.

Changes since `ddd922c` include:

- Add [bounded provider recovery](docs/PROVIDER_RECOVERY.md): validated retry hints respect the original reconnect cutoff, spending and uncertain outcomes. An explicitly manual model permits an authorized attempt without discovery GETs and without claiming provider health; advertised membership checks remain.
- Add [strict UTF-8 request intake and checkout guidance](docs/OWNER_INTAKE.md), preserving valid fragmented text, existing byte limits, authentication, exact preparation and replay contracts.
- Qualify [current-state SQLite backups](docs/CURRENT_BACKUP_QUALIFICATION.md) against a real Coordinator/Store and committed WAL. External artifact references are preserved; artifact bytes and restoration remain separate.
- Preserve the primary `Store.tx` failure when rollback cleanup also fails. [Bounded storage-fault fixtures](docs/STORAGE_FAULT_QUALIFICATION.md) retain the original negative measurement, accounting and unknown ownership; SQLite page exhaustion does not establish physical disk-full or ACL qualification.
- Add the public [six-stage roadmap](docs/ROADMAP.md), keeping source/fixture progress separate from actual owner use and launch evidence.

### Dated local verification summary

The required Mac run passed **2,555/2,555 tests across 167 entry files**, with zero failures, cancellations, skips or TODOs and unchanged frozen source/browser inputs. Separate [Ubuntu portable source CI](https://github.com/TanujBuilds/Mosaic/actions/runs/44088034305) passed **2,156/2,156 tests across 130 entries**, with the same zero counts; 37 entries require separate qualification. These results belong to the named source revision and are not a product-completion percentage.

Real local staging produced `0.1.0-beta.192` and `0.1.0-beta.193`. Each archive's 3,805 payload entries, including 131 runtime source modules, passed byte/mode, source/runtime/input and installer-checksum checks. The required Mac suite used this fresh pair for owned native/browser/installed fixtures. Seven-record strict integrity sidecars and independent actual-evidence review passed, with original build-time and external gates preserved. The separate beta188/189 wrapper/support composition belongs only to the earlier checkpoint below.

Qualification-wrapper outer groups were observed absent. Intentional uncertain-owner negative fixtures retained their roots, SQLite state, approvals and unresolved ownership.

These are **local archives and disposable installed fixtures, not public releases**. M001 remains blocked by protected TCP/Unix denial and missing Postgres proof. The three-worker proof is scripted fixture evidence, not M063. Actual host discovery/calls (M003), useful ordinary owner projects (M079), clean-Mac use and authenticated public distribution remain separate. Publisher authenticity is not established. This prose reports accepted evidence without rerunning qualification or granting new execution or publication authority.

## Source checkpoint — November 17, 2026

Commit [`ddd922cd141bcc1a58f26969f4cc23847f6c955c`](https://github.com/TanujBuilds/Mosaic/commit/ddd922cd141bcc1a58f26969f4cc23847f6c955c), tree `922ed8752b9b6cccd5553b3fe672b6f7deefb115`. Accepted on November 17 for source, owned native/browser fixtures and disposable installed-package composition; the public source checkpoint was verified on GitHub. The November 16 tag and archive record below retain their original identities.

Changes since that historical checkpoint include:

- Add safe worker reconfiguration, saved-key identity guards and truthful setup/doctor readiness with explicit next actions. Actual host and model qualification remains separate.
- Add contributor setup, explicit portable and required Darwin test profiles, and pinned read-only source CI. Correct malformed reviewer and startup-timing fixtures without relaxing production checks.
- Record dependency/native notices and unresolved provenance questions. The newer staged archives include the unchanged third-party notices and distribution-provenance documents, including the additional fdlibm/Sun/V8 notice texts. This corrects notice inclusion for these newer archives; it does not retrofit beta184/185 or resolve the remaining applicability/legal findings.
- Add an explicit version/URL/trusted-digest archive downloader prototype and bounded read-only candidate/evidence verification. No qualified public binary or publisher authentication is declared.
- Reorient the README, architecture and project guidance around the current coding workflow while preserving the original fake/text demo and legacy overnight roles.
- Add lightweight bug, feature and pull-request templates with bounded, redacted evidence expectations.
- Record the unresolved private security-reporting channel instead of advertising an unconfigured route.
- Add [bounded redacted support export](docs/SUPPORT_BUNDLE.md), with an explicit home, preview by default and an optional new private output file. The installed CLI uses the same contract; no provider call, service startup or upload is performed by collection.
- Bound beta private JSON reads and reject unsafe file types, oversized inputs and observed replacements before accepting metadata. This is finite read protection, not a hostile-writer filesystem sandbox or full storage-failure qualification.
- Add [exact reviewed candidate staging](docs/REVIEWED_CANDIDATE_STAGING.md), composing the existing builder, verifier and notice inventory with retained ownership and unchanged external gates.
- Bound [package verification](docs/PACKAGE_VERIFICATION_LIMITS.md) by bytes, files, directories and path depth, using descriptor-based reads and incremental payload hashing. Integrity checking does not authenticate the publisher.
- Correct terminal display-cell wrapping and padding, with [runtime-specific measurement and owned-PTY checks](docs/TERMINAL_QUALIFICATION.md). This does not certify every Unicode sequence, terminal or platform.

### Dated local verification summary

The accepted required Mac run passed **2,433/2,433 tests across 163 entry files**, with zero failures, cancellations, skips or TODOs. The separate Ubuntu portable source CI passed **2,034/2,034 tests across 126 entries**, also with zero failures, cancellations, skips or TODOs. These are accepted results at the named source revision, not full-suite reruns by this documentation change or a percentage of product completion.

Real local staging produced `0.1.0-beta.188` and `0.1.0-beta.189`; each archive's 3,803 payload entries, including 129 runtime source modules, passed byte/mode and source/runtime/input binding checks. A finite owned loopback transfer exercised the existing wrapper: disposable install of `.188`, installed support export, update to `.189` in the same disposable home, then installed support export again. The owned processes were verified quiescent. Subsequent strict integrity sidecars and independent evidence review passed; original build-time gates were preserved.

These are **local archives and disposable installed fixtures, not public releases**. No actual host/account or live-model owner run, three independently qualified endpoints, clean-Mac journey, signing/notarization or authenticated distribution was established. M001 remains blocked by protected TCP/Unix denial and missing Postgres proof. The [roadmap](docs/ROADMAP.md) retains the separate evidence and approval prerequisites. No package/build/full-suite qualification was rerun for this prose.

## Source checkpoint — November 16, 2026

Commit [`a23bae40d733fd711075ca798f83fbe9cc5ac633`](https://github.com/TanujBuilds/Mosaic/commit/a23bae40d733fd711075ca798f83fbe9cc5ac633), tree `49f2b66d21c53950eff6127daf68e2ae2819a5d7`, tagged [`mosaic-checkpoint-2026-11-16`](https://github.com/TanujBuilds/Mosaic/tree/mosaic-checkpoint-2026-11-16). The source was made public on November 16. Earlier internal package and personal-installation numbers are not a public release series.

The checkpoint includes:

- Versioned goals, exact scope/approval bindings, four workflow modes, native candidate worktrees, protected checks, checked integration and durable review/recovery.
- Explicit worker selection and specialty routing, shared physical-capacity groups, service/goal/profile limits and retained capacity for uncertain work. Three-worker source/fixture rehearsal is separate from three qualified real endpoints.
- Portable Darwin arm64 package construction and guarded install, migration, update, rollback and uninstall. Ordinary coordinator Node 24.22.0 and the separate fingerprinted native check artifact have different roles.
- Setup for one existing worker or guided two/three-worker profiles, separate optional hidden keys, default/planner/specialty choices and conservative shared-capacity limits. Real-host portable registration remains manual/unprobed.
- Separate default-no discovery and inference consent, transient connectivity evidence, bounded JSON/SSE provider diagnostics and GET-only `doctor --providers`. Model listing and a small inference probe do not prove coding quality or an actual host connection.
- Credential identity checks before setup preview, probes or persistence, including the coordinating corrections for composed JSON escapes and raw/normalized identities with merged saved keys.

### Dated local verification summary

The **M027 coordinating acceptance, November 16, 2026**, binds the checkpoint above to 2,208 passing tests across 150 committed entry files, with zero failures, cancellations, skips or TODOs in its final required native/Chromium/installed run. Its independent evidence audit records unchanged tracked bytes/modes, HEAD and tree through verification. This is a report of the accepted run, not a new full-suite result from this documentation change. Detailed logs and private machine bindings remain in the local acceptance handoff rather than this public repository.

That record also verifies local archives `0.1.0-beta.184` and `0.1.0-beta.185`: 3,800 payload entries each, including 128 runtime source modules, with byte/mode and input-fingerprint checks. These are **local artifacts, not public GitHub releases or downloads**. The earlier [portable release record](docs/PORTABLE_BETA_RELEASE.md) documents the historical installed-fixture contract and remaining gates; its stage-specific dates and versions are retained.

Acceptance covers source, owned fixtures and disposable installed proof. It does not establish actual coding-app accounts, current live-model quality, ordinary owner projects, clean-Mac use, signing/notarization or authenticated distribution. M001 remains blocked by the protected TCP/Unix boundary and missing Postgres proof. M063 remains unproven; one distributed API across two machines is not multiple independent workers. Public source availability does not close those gates.

## Earlier workflow history

October text-handoff and narrow overnight pilot results remain in [milestone history](docs/MVP.md) and [dated verification](docs/VERIFICATION.md). The November 4 personal coding core has a separate [scope and lifecycle](docs/MOSAIC_CODING_CORE.md). Those observations are not portable-beta compatibility claims.
