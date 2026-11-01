# Offline readiness contract

This tool checks explicitly supplied local inputs and prepares review files. It does not query providers, invoke candidate code, run subprocesses, inspect personal installation, register MCP, or start services. Use reviewed source for the checker; its existing `verifyPackage` and `renderLaunchAgent` imports are trusted local code. Candidate JavaScript is data only. Node24 is the tested runtime; locked MCP SDK1.32.2 is the candidate contract. The tool supports policy2/research@3, not historical policy1 acceptance or active-policy downgrade.

Run from the isolated reviewed checkout on the Mac; choose a **new** output directory with an existing parent. Each argument remains data, including spaces and shell punctuation when quoted:

```sh
node scripts/release-readiness.mjs --help
node --test test/release-readiness.test.mjs
node scripts/release-readiness.mjs \
  --candidate "$VERSION" \
  --expected-content-hash "$EXPECTED_CONTENT_HASH" \
  --expected-manifest-sha256 "$EXPECTED_MANIFEST_SHA256" \
  --receipt "$NORMALIZED_RECEIPT" \
  --output "$NEW_STAGING_DIRECTORY" --prepare
```

Resolve every variable explicitly; do not copy private machine values into tracked files. Both hashes must come from independently retained approval/review evidence, never solely from the supplied manifest. Content hash covers canonical inventory metadata; manifest SHA256 covers its exact bytes. Strict inventory verifies each file and rejects unlisted directories/files/caches and symlinks. No hashes are inferred or fetched. Unsupported/incomplete packages fail before preparation. All four sibling SKILL.md entries and both actual locked/installed SDK1.32.2 are required; manifest declarations alone are insufficient. Nonregular files (including FIFOs) are rejected before open, with nonblocking/no-follow descriptor checks retained.

Exit0 means supplied evidence projects sufficient **advisory pre-promotion** gates; exit3 means a valid check with pending/failed gates (including a successfully rendered proposal); exit2 means rejected input or failed staging. Inspect stdout JSON and stderr summary. Invalid data yields bounded fixed error codes, never raw paths, JSON text or credential values. `--help` takes precedence and creates nothing. Importing the module does not call main. `checkReadiness` and `renderPlan` return data; `prepareBundle` accepts only a report produced in that process by `checkReadiness`.

All output directories are exclusive creation, including empty/interrupted/completed existing directories. A partial bundle is evidence: retain it, inspect the failure and use a new destination. Completion is recorded last in `staging-receipt.json`; verify every listed file hash. Hashes are deterministic for identical inputs. Templates contain future `/ABS/...` placeholders and no secrets. The real renderer's `com.frontier.harness` label is retained for review; **never bootstrap this rehearsal**. Output cannot overlap candidate/evidence roots or selected personal service/skill locations. The tool does not protect against a concurrent privileged/same-user writer changing input or output paths; run against stable immutable inputs in an exclusively owned staging parent.

## Evidence interchange

[receipt.schema.json](receipt.schema.json) documents receipt, index, assessment and optional sealed-handoff definitions. Runtime also checks cross-field binding, duplicate IDs/gates/artifact paths, canonical paths, hashes, total sizes and status applicability; JSON Schema alone is insufficient. Unknown fields/schemas reject, including `verified`, `trust`, command and bypass fields. Supply `--receipt FILE`, `--evidence-index FILE`, both with nonoverlapping gate ownership, or neither (all evidence gates pending). An explicitly supplied missing file is an error; an omitted mutable lane handoff stays pending. Never point at intermediate PROGRESS as completion evidence.

A receipt has exactly `schema:1`, `id`, `candidate`, `policy`, `gates`:

```json
{
  "schema": 1,
  "id": "reviewed-offline-export",
  "candidate": {
    "contentHash": "EXACT_64_LOWERCASE_HEX",
    "manifestSha256": "EXACT_64_LOWERCASE_HEX",
    "sourceCommit": "EXACT_40_LOWERCASE_HEX"
  },
  "policy": {"version": 2, "finish": "selectors_only", "discovery": "search_required"},
  "gates": []
}
```

The placeholders above intentionally do not validate. Each gate supplies `name`, `status`, `applicability`, `scope`, `authority`, `artifacts`. Status is passed/failed/pending/unknown/not_applicable. Applicability is current/historical/not_applicable; the last must pair with not_applicable status and never waives a required gate. Scope is offline/fixture/live/installed. Authority is independent_native/operator/coordinator/model. Each artifact supplies relative `path`, exact `bytes`, `sha256`, and role proof/report/source/assessment/review/receipt. Paths resolve relative to that receipt, not the shell cwd. All references must exist, be regular and match their checksum. No symlinks, traversal, backslashes or implicit folder scans. Standard macOS `/var` and `/private/var` (also `/tmp`) aliases are canonicalized before checks; other symlinks are rejected.

Bounds: JSON1MiB (candidate manifest2MiB), depth16,150000lexical tokens,32receipts,8gates/receipt,32artifacts/gate,8MiB/artifact,64MiB total evidence reads including repeated references,10000candidate files/128MiB total/16MiB per file. Generated files total at most256KiB. The parser rejects duplicate JSON keys before parsing. Larger old receipts must be converted into a small bounded export with selected immutable artifacts, never silently truncated.

An evidence index is `{"schema":1,"receipts":[{"path":"receipt.json","bytes":123,"sha256":"..."}]}` with actual sizes/hashes. Duplicate receipt IDs or repeated gate names across receipts fail even if their status agrees. This avoids silently choosing between conflicting assessments. Reviewers must explicitly reconcile old and new evidence into one new export, preserving both originals.

To convert existing heterogeneous receipts (including historical receipt16): retain originals byte-identically; copy only necessary immutable proof/review artifacts into a new private evidence directory, compute their exact hashes, and author a new normalized receipt naming the candidate runtime source and current policy. Record who made the applicability judgment in the independent review. Map the saved offline implementation proof to implementation/offline. Preserve policy1 failures as historical evidence in separate exports; do not bind an old report to the current candidate or relabel offline diagnostics as live. A normalized export is a review declaration, not automatic translation or signature. The checker never overwrites old receipts.

## Gates and semantic assessment

Implementation requires current nonfixture evidence from an independent native reviewer/operator. Live research quality requires current live independent_native evidence: exactly one report, primary source artifacts, one structured assessment and one actual independent review document. The assessment binds candidate/policy, `reportSha256`, exact unique `sourceSha256s` (one-to-one with source artifact hashes), `reviewSha256`, status and nonempty uniquely identified `criteria` with passed/failed/pending statuses. A passed assessment requires every criterion passed. Reviewers choose the criteria from the actual approved task; this tool cannot judge their completeness, entailment or the author's identity. Inspect the bound review document against exact official report, selections and primary archives. A status string or model/provenance verdict alone leaves quality pending. Conflicting hashes reject; a declared failed quality gate remains failed even when transport/provenance succeeded.

A checksum establishes integrity, **not authenticity**. Anyone who can author receipts can declare independent authority. Use separately trusted reviewer exports and scrutinize them; never treat exit0 as authentication, authorization or semantic certification. `prePromotion` combines implementation and live research quality only. `activation` reports personal_activation; `postActivation` combines actual installed_host_discovery, persistent_research_worker, physical_phone and installed_restart. Missing installed checks do not block proposal rendering. Model/coordinator approval and fixture installed checks cannot pass those gates. Active-policy rollback is always pending/unsupported in this version, even if a terminal-only receipt says passed. `fullRelease` remains INCOMPLETE; the checker performs no personal inspection and grants no installation authority.

Optional sealed handoff: the evidence index may include `seal` with exact file references `done`, `result`, `resultSha256`, `index`. See `$defs.done`, `$defs.sealedResult`, `$defs.sealedIndex` for the small supported adapter format. DONE binds result hash, index hash, candidate content and matching terminal status; the sidecar is the bare result hash plus optional newline. Every indexed artifact is rehashed. Convert a differently shaped lane result into a new adapter, preserving the original sealed files as indexed proof; never edit original DONE/result/index. A valid seal proves completeness/integrity only. Quality still needs its separate bound assessment/review. Unsealed or missing live handoffs are never inferred from an intermediate status string.
