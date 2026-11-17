# Distribution provenance

This is a dated audit of the 16 November 2026 (America/Los_Angeles) accepted source baseline and two local candidate archives. It establishes inspected identities and notice locations, while retaining the specific unresolved questions below. It is not a published download channel, legal clearance, reproducible-build attestation, clean-Mac result or release approval.

## Audited boundary

| Input | Exact identity |
| --- | --- |
| Source commit | `a23bae40d733fd711075ca798f83fbe9cc5ac633` |
| Source tree | `49f2b66d21c53950eff6127daf68e2ae2819a5d7` |
| Root lock SHA-256 | `a390331015b970a682124187f756224994c019f93007b411b16ce6ef6a2e0cb6` |
| Local beta184 archive | `mosaic-beta-0.1.0-beta.184-darwin-arm64.tar.gz` — `6fe258433a4086990ef7e41c7f513f9814cc23e598c38970ba22433d6ac5735e` |
| Local beta185 archive | `mosaic-beta-0.1.0-beta.185-darwin-arm64.tar.gz` — `f58fd5bb314b3646457c6be2a5608486141c286649bac7ecb1af44c69b645dc5` |
| beta184 external candidate JSON SHA-256 | `ea3ded4fb93e655936303c6037ba130b0398404c5c02d6c2e913e38bbb6acdf7` |
| beta185 external candidate JSON SHA-256 | `453949e1030d968efaee774ed537dea6bf073d337b07f4e1c2635e807802a19f` |
| beta184 `payload/package-manifest.json` SHA-256 | `a53f33b990c2ad65b351064155ea2e95ad69e865e33444509baff00feed848d7` |
| beta185 `payload/package-manifest.json` SHA-256 | `e53aca17904e64ca095bb0b3952fbeef2a782bc2bb47b2c621094fd3dd017c49` |
| Common payload content hash | `6c25eda827132ab7f16601a73d3c391510853f8b9286507eef6508343dfa149e` |

The public [source checkpoint](https://github.com/TanujBuilds/Frontier-Orchestration/tree/a23bae40d733fd711075ca798f83fbe9cc5ac633) is an experimental MIT source preview. The archive filenames above identify retained local inputs; no public archive URL is asserted. Both external candidates bind this exact clean source commit/tree and archive hash. This audit inspected their actual contents rather than relying only on the candidate metadata.

The supported package target is Apple Silicon macOS (`darwin-arm64`, native arm64 terminal). This inspection establishes no clean-Mac or broader macOS-version support matrix, other-platform support, current host/account readiness, live model result, signing/notarization or authenticated download qualification. Historical source-suite/native fixture acceptance is separate evidence and was not rerun for these documentation changes.

## Two separate Node runtimes

### Ordinary coordinator Node

[The package builder](../scripts/package-beta.mjs) pins the official [Node 24.22.0 Darwin arm64 archive](https://nodejs.org/dist/v24.22.0/node-v24.22.0-darwin-arm64.tar.gz). The retained archive was hashed and its binary/license compared with the accepted payloads.

| Item | SHA-256 | Shipped location / mode |
| --- | --- | --- |
| Official upstream archive | `6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5` | Upstream input; archive itself not bundled |
| Ordinary Node binary | `b468fb9c67427c9d3aec07ee1105e63020923a631a9a2a00beb71a7ba3768bfd` | `payload/runtime/bin/node`, 0755, 122,503,472 bytes |
| Full upstream top-level license | `5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace` | `payload/runtime/NODE-LICENSE`, 0644, 157,609 bytes |

Read-only signature metadata display reports an embedded Node.js Foundation Developer ID signature on the ordinary upstream binary. Displaying that metadata does not verify certificate trust, revocation, notarization or an upstream archive release signature, and does not authenticate a Mosaic archive. This audit did not validate an upstream signed checksum document.

### Fork-path check Node and C supervisor

The check runtime is built from the official [Node 24.22.0 source archive](https://nodejs.org/dist/v24.22.0/node-v24.22.0.tar.xz), with the separately reviewed [fork-only patch](../test/fixtures/mosaic-pb15-v2-composition/fork-only.patch). It disables the Apple libuv `posix_spawn` branch before file-action changes, using libuv's existing fork path. The patch alone supplies no containment guarantee; the backend policy and protected native gates are separate mechanisms. The coordinator keeps the ordinary upstream binary.

| Item | SHA-256 | Shipped location / mode |
| --- | --- | --- |
| Official source archive | `41f97cff2c666f1f8293dc5f85c65e8dd605c16b43fd9febd49ede32ee1e0329` | Upstream input; archive itself not bundled |
| Reviewed 376-byte patch | `840109e32a582faf92ed07f75987c6eb03c9b5659cf74b2f5231ac1e72594741` | `payload/runtime/provenance/fork-only.patch`, 0644 |
| Patched check Node | `5fab3a0eec5016b63ba8e3be67a9f98b27ef0993611dcd7d01bfdd6d73bb009b` | `payload/runtime/check-artifact/node`, 0755, 126,650,264 bytes |
| Full upstream top-level license | `5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace` | `payload/runtime/check-artifact/NODE-LICENSE`, 0644 |
| Trusted supervisor C source | `8f1c0f05b426bc08f81334ef1838ca1a4a34c75f66c0f1a8995ca411240cf0e4` | `payload/runtime/src/project/check-backends/native-supervisor.c`, 0644 |
| Compiled C supervisor | `72463fbef2c6aca73f8c01244882d127a9a67f6f6da07aa0ab5c06b7fdfebe9d` | `payload/runtime/check-artifact/mosaic-check-supervisor`, 0755, 35,832 bytes |
| Native artifact manifest/fingerprint | `a8359593981bcc572717923568712d1bcf23e7a28d7cf7c59f0d737ce885fbaf` | `payload/runtime/check-artifact/artifact-manifest.json`, 0600, 1,384 bytes |
| Native artifact builder source | `200f8b210dd1bf3f1e10549d180c8f98902468e26945242733dacfa72ba4ab34` | `payload/runtime/provenance/build-native-check-artifact.mjs`, 0644 |

The trusted [supervisor source](../src/project/check-backends/native-supervisor.c) is Mosaic source under the unchanged project MIT license. The Node patch modifies upstream libuv code, whose terms remain in the Node license. The artifact manifest records supervisor protocol 1, Darwin arm64, Node 24.22.0 and Apple clang 21.0.0 (`clang-2100.3.34.2`), using `/usr/bin/clang -std=c11 -O2 -Wall -Wextra -Werror`. That compiler field describes supervisor compilation; it is not a complete Node build-environment attestation. Read-only metadata shows the local check binary and supervisor have ad-hoc signatures and no TeamIdentifier; these are not Mosaic publisher signatures. The supervisor links the macOS system `libSystem.B.dylib`, which is not copied into the archive.

Retained neutral-path build evidence dated 12 November records successful `./configure` and `make -j4`, the source/patch pins and the resulting check binary hash. This audit compared all 33,472 regular files in the pinned upstream source archive against the retained build source: the sole changed original file is `deps/uv/src/unix/process.c`, exactly matching the reviewed patch. Original-file comparison excludes build-generated additions. The check binary contains none of the private owner-home/task-state markers checked by the packaging boundary. The logs and input comparison support the recorded provenance; they do not constitute a second independent binary rebuild, a hermetic toolchain manifest or a demonstrated reproducible upstream binary build.

The fingerprint is SHA-256 of the exact artifact-manifest bytes, including the newline. It binds the two executables, license, source/patch identities and recorded compiler inputs. The [artifact build contract](NATIVE_CHECK_ARTIFACT.md) explains ownership and validation. A manifest records provenance assertions and content identity; it cannot infer source from a binary's version string or independently establish publisher authenticity.

## Dependency and archive closure

The [third-party notices](../THIRD_PARTY_NOTICES.md) enumerate all 95 installed production locations (92 distinct name/version pairs), their declared licenses and complete included notice paths. The exact root lock retains registry origins and integrity pins. Package manifests and every shipped dependency byte agree between beta184 and beta185. A read-only comparison also verified all 95 cached npm tarballs against the lock's SHA-512 integrity pins and every regular package file against the installed payload, excluding separately inventoried nested dependencies. These are content bindings, not npm publisher/signature verification. Optional peers absent from the lock are distinguished from installed packages. All included root license texts and a source-header attribution scan over UTF-8-decodable production text, including source maps, were inspected; package metadata alone was not treated as the license of embedded code.

For each accepted archive, this audit checked the external candidate/archive/inventory hashes, every one of the 3,800 manifest-listed file bytes, size and mode, the native artifact's three member pins, and the source/build-input bindings. The payload inventories are identical; archive roots/version metadata differ. The source closure hash is `bb98c66dbdff883b7311d74c257acfa0ebe1eb3428b9c33589ec66e60a965fcc`. The archive also carries `payload/package-manifest.json`, `verify.sha256` and an installer that pins the checksum index. Inventory hashes bind contents; they do not establish a trusted download origin.

The inspected archive includes the intended runtime source closure, MIT license, both Node notice files, all 95 production root licenses, dependency notice index, reviewed patch, supervisor source, native builder, candidate schema and the five selected existing install/native/host/release guides. Upstream Node source/binary archives, full Node source trees and private build logs are referenced inputs, not physically bundled assets. Playwright, Chromium, FFmpeg, the separate offline project/demo archive, source dashboard font, repository history, local configuration and task state are absent. The source dashboard font and its OFL notice remain in the public source tree.

No unsafe archive paths, aliases, private task-state entries or checked owner-home/task-state byte markers were found in either candidate. This was a bounded archive/owned-diff exposure review, not an exhaustive secrets guarantee. The coordinator's dated source-history exposure review remains separate; it does not replace a native/dependency notice audit.

[Archive construction](../scripts/lib/beta-archive.mjs) uses sorted ustar entries, pinned bytes/modes, zero timestamp/owner/group and gzip, with no macOS extended attributes. This is deterministic packaging of fixed inputs, distinct from reproducing the compilation of the upstream or modified Node binary. No fresh package/runtime build or product suite was run during this audit.

## Findings requiring disposition before a qualified distribution

| Finding | Affected output and required follow-up | Current disposition |
| --- | --- | --- |
| Embedded dependency attribution | Hono credits goober/React and unversioned type-fest; iconv-lite carries Microsoft credit; fast-uri includes a separate test-source notice; json-schema-typed includes documentation/IETF author terms. cross-spawn and zod have external algorithm/regex references requiring targeted terms review. Preserve these headers and establish the exact borrowed-source grants, especially type-fest. | Original files preserved; no blanket package-root-license clearance. |
| Incomplete upstream attribution field | `pkce-challenge` 5.0.1's MIT file omits a holder after its 2019 copyright. Confirm upstream provenance without inventing or rewriting attribution. | Original notice retained; question open. |
| Additional Node source notices | `deps/v8/LICENSE.fdlibm` and the Sun/V8 notice in `src/base/ieee754.cc` are absent from top-level Node notices; the retained check build compiles `ieee754.o`. Both complete notices are now preserved in [Third-party notices](../THIRD_PARTY_NOTICES.md). A future builder must carry them into the package and resolve the other V8 notice applicability findings, including evaluation of the official binary. | Concrete pre-distribution notice gap in unchanged beta184/185; source-document remedy supplied, archive closure remains open. |
| New audit documents absent from old packages | A separately owned builder change must include `THIRD_PARTY_NOTICES.md` and `docs/DISTRIBUTION_PROVENANCE.md`, plus any additional required notices, and regenerate package/candidate inventories. | Documents added to source only; immutable beta184/185 inputs unchanged. |
| Reproducibility and build attestation | Retain native logs/toolchain inputs; an independent exact binary rebuild has not been demonstrated. | Deterministic archive construction is the narrower supported claim. |
| Publisher authenticity | Select an authorized signing identity/channel, verify upstream authenticity as required, and qualify download-to-use. | No Mosaic release signing, notarization or authenticated public installer is established here. |
| Final-byte order | Signing can change executable bytes. Sign final executable bytes before computing native/package fingerprints and binding approvals; requalify affected artifacts afterward. | No signing or runtime/policy identity change in this lane. |
| Combined integration rebind | This report binds only the stated source/lock. Inspect subsequent metadata/dependency/source changes, including another lane's root engine/script metadata, and bind the combined commit/tree, hashes and final packages again. | Coordinator-owned integration and broader qualification remain open. |

A successful documentation audit preserves these unresolved findings; it does not close legal, release, clean-Mac, actual-host or real-model gates. This change preserves the original MIT source license, dependency versions, build scripts, native policy and all audited inputs.
