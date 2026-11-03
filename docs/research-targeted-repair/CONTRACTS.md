# Targeted correction v1 contract (frozen before implementation)

All hashes are SHA256 of UTF-8 sorted-key compact JSON with literal Unicode,
no NaN. Canonical report/source/offer strings are hashed as their exact UTF-8 bytes.
No normalization, whitespace folding or semantic equivalence is applied to values.
JSON object keys are closed. Integers exclude booleans. Array order is significant.

| Object | Exact fields and bounds |
|---|---|
| Policy | Existing policy3 + repairContextVersion:1 + correctionStrategy:targeted_v1; collaborative, autonomous research actor; research@6. Absent strategy retains exact @1–5 behavior. |
| Base | Exact existing v1 descriptor, canonical report and A offers; source digest equals current sources. Base report <=131072 UTF-8 bytes. |
| Plan v1 | version, baseCandidateHash, baseDescriptorSha256, baseReportSha256, sourcesSha256, offersSha256, rubricSha256, review, units, required, summaries, edges, affected. review={ticketId,submission}; submission is the exact existing closed review-submit record including key. units=[{unit,beforeSha256}] in canonical report order. required is sorted unique directly failed non-summary units. summaries=[{unit,claim}] for failed summary pointers. edges=[{from,to}] sorted by from/to, derived from all summary and synthesis claim_ids. affected is sorted unique required/failed-summary/summary-claim units plus their dependents. Closure <=250; no truncation. All before values are bound through baseReportSha256 and per-unit hashes. |
| Action | action:repair, base_candidate_hash, plan_sha256, replacements:[{unit,before_sha256,value}], checked_units:[{unit,before_sha256}], cannot_repair:[unit]. Total unique replacements+checks <=250, disjoint. Raw response <=150000 characters. No unknown fields or arbitrary paths. |
| Claim value | Closed id,kind,text,evidence; same id; evidence is unchanged strict raw source_id/text_sha256/start/end selectors from exact correction offers. Resolve changed claims alone. |
| Other values | title string 1..300; unanswered string 0..3000; summary existing claim ID; synthesis closed text (1..6000), claim_ids (nonempty existing IDs). Whole report validator remains mandatory. |
| Required changes | Every plan.required is canonically changed. Each failed summary either changes pointer to an existing claim or retains pointer only when referenced claim changes. Changed claims require each structured dependent to be replaced or checked. Only affected units can be edited/checked. Canonical no-ops reject. |
| Cannot repair | Unique nonempty subset of required + failed-summary units; replacements/checks empty; validate base/plan/membership then short-circuit completeness. Apply nothing, stage no B; existing partial/not_accepted finalization; complete:false. |
| Receipt v1 | version, baseCandidateHash, planSha256, patchSha256, request, reportSha256, sourcesSha256, offersSha256, retained, changed, rechecked. retained=[{unit,sha256}], changed=[{unit,beforeSha256,afterSha256}], rechecked=[{unit,beforeSha256}], all sorted by unit. request is exact existing operationId/requestSha256/resultSha256/offersSha256 reference. No B candidateHash cycle. |
| Bundle v1 | version,base:{descriptor,report,offers},plan,patch,correctionOffers,receipt. report/offers/correctionOffers are exact canonical JSON strings. Entire canonical bundle <=262144 UTF-8 bytes. |
| Descriptor v2 | All existing descriptor fields, version:2, plus assembly={version:1,baseCandidateHash,planSha256,patchSha256,receiptSha256,bundleSha256}. Hash covers full descriptor except candidateHash. Initial @6 uses v1; repaired @6 requires v2; old policies reject v2. |
| Catalog | A and correction <=96 each, union <=192, selectors deduplicated and sorted source_id/text_sha256/start/end; conflicting duplicates reject. Retained selections resolve only against A, replacements only correction. Python character offsets = Node Unicode codepoints. request.offersSha256 hashes correctionOffers; descriptor.offersSha256 hashes union; receipt.request exactly descriptor.request. v1 equality unchanged. |
| Local authority | Rebuild plan from locally acknowledged revise ticket/submission/descriptor, compare exact remote plan; reconstruct B using exact sources and patch. Store generated candidate-bound proof artifact in coordinator research-proposals directory. Query-only authority revalidates artifact and local records. No caller-supplied path or remote verified flag. |
| Final export | Fixed file list unchanged; accepted @6 B receipt adds targetedRepair exact bundle. Collection compares saved local proof; legacy receipts unchanged. Partial abort has no accepted descriptor or B metadata. |

Pure Python API: build_plan(base, submission, ticket_id) -> plan;
apply_patch(base, plan, patch, sources, correction_offers, request) ->
{report,offers,receipt,bundle} or None for explicit cannot_repair;
describe_plan(base,plan) -> exact bounded unit/value/hash/action-shape context.
Here base is the exact {descriptor,canonical} A packet. Plan rederivation is required
on use, not just trusting its own checksum. Node verifyTargetedRepair(packet,task)
reconstructs the same mapping with local review authority and returns the bundle.

Replay uses the existing reserved operation/result, identical immutable base/plan,
append-only content-addressed artifacts and existing checkpoint transactions.
No extra rounds, retrieval, deadline extension, spending reset or ownership release.
A missing/inconsistent snapshot fails closed; oversize exact proof ends partial.
Structural success is never semantic acceptance; whole B requires a new ticket,
full unchanged rubric coverage and independent verdict.

Recovery boundary: under the existing exclusive worker flock, startup may mark an
active execution quiescent ONLY for a committed targeted-policy waiting/terminal
job with no pending operation. Waiting packet and completed accepted artifacts are
rehash/reconstructed first; invalid evidence becomes uncertain. Uncertain owners
and running jobs are excluded. This closes SIGKILL after staging/finish without
new inference, review, accounting changes, or early ownership release.
