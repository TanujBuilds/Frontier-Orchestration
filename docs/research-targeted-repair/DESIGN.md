# Design — closed targeted corrections, then full independent review

## Chosen approach and alternatives

The owner agreed to investigate targeted correction after repeated context fixes.
Use an explicit opt-in targeted replacement action during the ONE existing
semantic correction round. Preserve the report format and independent whole
replacement review. Do not add more reviews or calls.

A prompt-only condition checklist leaves the original mechanical failure intact:
the model can fix another paragraph and skip the flagged claim. Unrestricted
JSON Patch allows unrelated changes, insertion/index drift and arbitrary paths.
Choose bounded named report-unit replacements bound to an immutable reviewed base,
with coordinator-derived dependency accounting and no executable authority.

A scripted successful patch proves mechanics only. A model can change punctuation
and still be wrong. Include that negative case and show final review rejects it;
do not build a keyword truth oracle or hardcode this Celery answer.

## Versioning and lifecycle

Introduce optional closed `correctionStrategy: "targeted_v1"` alongside existing
policy3 + repairContextVersion1, pinned to new research@6. Reject it without
those exact prerequisites or outside collaborative mode. Existing @1–5 schemas,
normalization, hashes, reserved payloads and actor restrictions remain unchanged.
No active/old task gains new behavior on software upgrade. Default parse_action
behavior remains closed to current actions; permit `repair` only when new policy
AND genuine acknowledged review-revise state authorize it. Model text cannot set
that state. Initial research/drafting still uses existing full finish reports.

The same task/job/deadline, one correction round, maximum2already-budgeted calls,
request reservation/replay and whole-report reviewer limits remain. No additional
retrieval in correction. No automatic Codex model calls are introduced by Python
or coordinator code.

## Immutable repair plan

When review A submits revise, snapshot its exact current canonical packet BEFORE
clearing active state. Derive the plan from that packet plus verified submitted
findings/coverage, never from model output. Persist a versioned immutable artifact
and checkpoint reference before next dispatch. Include baseCandidateHash,
baseReportSha256, sourcesSha256, original offersSha256, rubricSha256, genuine ticket
and submission binding, canonical per-unit hashes, required replacement units and
structured dependency edges. PlanSha256 is canonical JSON SHA256; stale/missing or
altered files fail closed. No raw paths or source instructions grant authority.

Use existing unit names: title, claims:C#, summary:index, comparisons:index,
recommendations:index, contradictions:index, unanswered:index. No general JSON
pointer, code, shell, file path or executable field. Unit hashing uses exact
canonical stored values, not model-provided equivalent prose or selector-view
serialization. Include the authoritative hash in the model context for echoing.

For each directly failed content unit, require a real replacement of THAT unit.
For a failed summary pointer, require replacement of the referenced claim or a
changed pointer to another existing claim. A retained summary pointer is permitted
only if its referenced claim is genuinely replaced. Findings on title/unanswered
or synthesis text directly require their unit replacement. Map claim changes to
all structured summary and claim_ids references; required/rechecked sets are
coordinator-derived and not a source/model declaration. Lexical references or
unstated semantic dependencies are NOT automatically detected—full review remains.

V1 scope is bounded replacement only: no insertion/deletion/reordering, new claim
IDs, changed complete flag, new source bodies or altered approval fields. A task
needing larger changes can explicitly end partial. Don't force a supported outcome
by deleting the troublesome claim or hiding it from review coverage.

## Closed model action

The correction response is exactly:

```json
{
  "action": "repair",
  "base_candidate_hash": "EXACT_BASE_HASH",
  "plan_sha256": "EXACT_PLAN_HASH",
  "replacements": [
    {"unit": "claims:C6", "before_sha256": "EXACT_UNIT_HASH", "value": "SCHEMA_DEPENDS_ON_UNIT"}
  ],
  "checked_units": [
    {"unit": "summary:5", "before_sha256": "EXACT_UNIT_HASH"}
  ],
  "cannot_repair": []
}
```

The value above illustrates structure, not a valid claim replacement. Claims use
the unchanged raw selector-only claim shape with the SAME id; synthesis uses its
unchanged text/claim_ids shape; title/unanswered string and summary existing-ID
shapes are unchanged. Closed per-unit fields and exact input types. Limit raw
response to existing150000characters and actual request HTTP196608bytes; bounds
remain stricter where existing contracts require. Maximum250unique replacement+
checked units; reject if required
closure exceeds250, instead of silently dropping required work. `cannot_repair`
is a unique list of known required units; if nonempty, no replacement is staged
and the job closes partial through existing safe finalization. No new acceptance
flags or model-generated explanations with authority.

Reject duplicate/unknown unit names, stale hashes, malformed replacement values,
no-op canonical replacement, missing required units/dependent checks, unrelated
unit edits outside required+affected closure, source/ID mutation and full-report
`finish` in the targeted semantic-correction phase. False confirmations do not
prove truth; checked_units are workflow acknowledgements, never semantic verdicts.
When cannot_repair is nonempty, replacements and checked_units must be empty; after validating the base/plan and known-unit membership, short-circuit BEFORE mandatory replacement/dependent completeness checks. The model is explicitly declining, not partially applying a patch. Apply nothing, stage no B, archive base/plan, and use existing partial/not_accepted finalization with complete:false; never export A as accepted. This must retain existing quiescence, ownership, spending and deadline controls. It cannot spend an extra research round or release ownership
before existing quiescence rules.

## Apply, validate, stage

Apply all replacements to a deep copy of the immutable reviewed base; never mutate
it or the official old report. Carry unaffected canonical units unchanged. Resolve
only new claim selectors against the request's actually offered saved sources;
verify original retained selections against the immutable A catalog/source bodies, not only the new request catalog. Retained canonical claims contain quote/selection fields and MUST NOT be passed to strict raw-selector resolve_report again (that parser rejects their shape). Resolve each replaced raw claim separately against exact saved correction-request offers, then assemble canonical values and run unchanged whole-report validation, discovery and policy checks.
Do not treat changed quote text or adjacent unselected context as supporting proof.
No partial application/checkpoint on failure. Repeated attempts are against SAME
base+plan; don't accumulate unreviewed patches across requests.

Store raw model patch, exact request/result/offers hashes, immutable plan, changed
and rechecked unit hashes, and assembled full report SHA as append-only evidence.
Define a closed versioned assembly receipt. The Python candidate/export and local
Node acceptance must bind this provenance, not a remote `verified` flag. Existing
closed descriptor/canonical envelope currently permit only v1; preserve it for
old policies. Prefer a new descriptor version2 for @6 repaired candidates with
one closed assembly binding `{version:1, baseCandidateHash, planSha256, patchSha256, receiptSha256, bundleSha256}`
added to the unchanged descriptor fields. CandidateHash covers this full new descriptor. Initial @6 candidates remain v1; repaired @6 candidates require v2 plus the assembly binding. Every old policy rejects v2, including when an untrusted remote packet supplies it.

### Exact provenance transport and catalogs

For @6 B only, extend proposal packet with one closed `repair` object:
`{version:1, base:{descriptor,report,offers}, plan, patch, correctionOffers, receipt}`.
Report/offers are canonical JSON strings; descriptor is exact A; plan/patch/receipt are closed typed objects. Base sources are not duplicated: their hash MUST equal B canonical.sources and the plan's sourcesSha256. `bundleSha256` hashes this entire repair object; `receiptSha256` hashes its receipt. Plan hashes base descriptor, genuine revise ticket/submission binding, before values/hashes and closure. Receipt binds base/plan/patch/current request/result, per-unit retained/changed/rechecked hashes, assembled report/source/catalog hashes. Do not include B candidateHash inside the receipt/bundle (avoids a hash cycle).

B canonical.offers is a deterministic de-duplicated union of immutable A offers and exact saved correctionOffers, sorted by source_id/text_sha256/start/end. Max192offers (96+96); every retained selection must belong to A and every new replacement selection to correctionOffers, even if both appear in the union. Hash B against this union, while request_ref.offersSha256 still hashes ONLY actual correction-request offers. Explicit invariants: receipt.request equals B.descriptor.request; digest(correctionOffers) equals B.descriptor.request.offersSha256; digest(unionOffers) equals B.descriptor.offersSha256. Therefore descriptor v2 explicitly permits this request/catalog distinction with proof in the receipt; descriptor v1 retains its old equality check unchanged. No new inference request uses the expanded union as an excuse to exceed the existing96requestoffer bound. Reject conflicting same-selector text, invalid indices, duplicate inconsistencies or source hash change. Python character offsets must match Node Unicode-codepoint checks, not UTF-16 slice offsets.

The whole canonical UTF-8 repair bundle is≤262144bytes, base report≤131072bytes, and≤192unionoffers. These are deliberate @6 narrowing bounds. If the required exact bundle cannot fit, end partial BEFORE staging B; never trim proof or strip only the failed units. Keep existing total packet/row/receipt limits too and test their interaction.

Node verifyProposal must mechanically verify the full base+patch→canonical B mapping and source/selector rules against exact bytes, not only remote hashes/booleans. It must compare A descriptor, genuine ticket, acknowledged local revise input, findings and plan required/affected closure with its own existing local review records. The remote copy alone cannot authorize a plan. Persist the validated repair proof in a generated allowlisted LOCAL artifact bound by B descriptor/bundle hash; no caller/model-supplied paths. Keep bounded hash references in SQLite if needed. Query-only local authority rehashes/validates that artifact and compares local A-revise/B-acceptance records; no subprocess, mutating Store or remote flag.

For final collection, keep the existing fixed file list/canonical report format. The new worker receipt contains opt-in `targetedRepair` equal to the exact bounded repair bundle; no extra unlisted file or changed old receipt bytes. Verify this bundle against the local saved proof during collection/finalization. Old receipts lack the key and remain byte/shape-compatible. A partial abort has no B assembly metadata or accepted descriptor: receipt status partial/not_accepted, report complete:false; archived unaccepted A/plan are labelled prior evidence. Existing accepted-local-intent and timeliness checks remain mandatory.

Freeze exact typed plan/receipt fields and mechanical verifier signatures in CONTRACTS before implementation; the transport, hash and local-revise requirements above are fixed. If a safe implementation cannot satisfy them, stop with the specific contract issue rather than weakening verifiers.

Candidate B goes through an actual new ticket and FULL unit coverage under the
unchanged rubric. Accept only exact accepted B/source/catalog/plan bindings.
A patched claim that remains unsupported must still fail semantic review.
Canonical/report exports retain current schema; targeted metadata is separate inside the explicit opt-in receipt key described above. Never replace the existing fixed artifact list or skip tamper checks.

## Context and recovery

The request presents actual flagged units, their before hashes, exact findings,
selected passages, typed replacement shapes and dependency closure. Include enough
unchanged context to repair safely; do not duplicate the whole old report in every
section. Preserve existing repairContextVersion1 for non-targeted behavior. Required
plan/units/findings/citation selections cannot be trimmed away; if exact critical
context exceeds196608wirebytes, save partial with explicit gap and no provider call.
No hand-wavy token estimate substitutes for actual completion_payload bytes.

Reserve before sending; failed/ambiguous calls stay spent. On response-save/apply/
artifact-save/checkpoint crash, replay the exact saved request/result and reproduce
same plan/report hashes without new inference. No multiple concurrent worker
ownership. Resume preserves deadline and counters. Missing/inconsistent base or
assembly state remains partial/uncertain per existing controls, not auto-repaired
by loading another job's data. No live DB is opened via mutating Store in tests.

## Boundaries of success

Offline success means mechanical omission of flagged units is blocked, dependent
references are accounted for, unrelated content is preserved, provenance/recovery
and policy isolation work, legacy hashes stay unchanged, and all required checks
pass on a new reviewed frozen package. It does NOT establish model comprehension,
semantic support or a pass in future live research. Do not claim full release.
