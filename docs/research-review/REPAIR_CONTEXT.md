# Versioned repair context — offline implementation

Policy 3 may explicitly select `repairContextVersion: 1`. The coordinator pins
that policy to **research@5**. The existing policy 3 / research@4 capability and
all earlier capability schemas remain unchanged. Absence of the key preserves
the previous generated request contract; unknown values fail closed. The policy
and capability participate in normal goal/task approval and manifest hashes.
Existing saved reservations always replay their original payload without prompt
regeneration. No historical task or manifest is migrated.

This is a writer-context change. Report fields, selector-only provenance,
`contradictions: [{text, claim_ids}]` validation, catalog version 2, the semantic
rubric and whole-candidate review/acceptance authority remain unchanged. Native
review limits, correction calls, IDs and deadlines are unchanged. No keyword
checker, implicit support verdict or automatic acceptance is added.

## Retained data

A new opt-in repair proposal adds a version 1 `repairContext`. It records the
exact input-report digest and reserved request/result/offers lineage. Each
nonclaim unit carries its descriptor-style unit ID, field/index path, exact
original value, digest and existing required shape. This includes malformed
strings; they are never silently coerced into objects. Unknown report-level
metadata is discarded. Values inside an original unit remain explicitly
untrusted data, including instruction-like text.

At the next final-phase request, `repair_context` joins retained original units
with findings for that exact unit and separate cited-claim bindings. Each binding
contains the actual claim text/kind and selected source ID, URL and selector.
Missing claims/selections are explicit. A separate hash-bound
`reviewed_repair_context` retains the originally reviewed candidate across later
malformed correction attempts. Findings identify that reviewed candidate; the
same section/index in rewritten prose is only a lookup hint, not unit identity. Those source identities are provenance
groups, not an inferred system/alternative name and not clause entailment. The
writer must map each named alternative and factual premise to actual supported
claim text and selected passages. A collective list of claim IDs is not
redistributed as proof for every clause or alternative. Conditional untested
designs can remain useful; their factual premises still need support.

Atomic reconstruction cards and canonical output retain their existing format.
Prior nonclaim prose is now separately available as untrusted correction input,
so fixing another premise need not erase previously separate attribution. Whole
replacement review still covers new comparisons, recommendations and gaps.

The nonempty contradiction syntax example reuses one valid current claim and
its existing offered selector. The worker runs the actual resolver and validator
before presenting it. It is marked illustrative, incomplete and unendorsed. If
no valid current claim exists, the example is omitted explicitly; no reference
or evidence is invented to populate it.

## Bounds and omissions

Persisted and presented repair contexts each cap their ASCII-escaped JSON at
32,768 bytes. Section iteration is capped at the existing report entry limits;
claim joins are capped separately. Whole values and joins are retained or
omitted. Text is never sliced at a qualifier. Counts disclose omitted units,
bindings and findings; at most 50 omitted-unit path/hash records are retained,
with a separate count for further omitted metadata. The whole input digest and
reserved response remain durable for exact investigation.

The complete dispatch uses the existing real `completion_payload` serializer
and remains at most **196,608 bytes**, including outer escaping. In opt-in final
requests, duplicate source prefixes and read windows yield before exact repair
units. A syntax example or whole units may then be omitted with explicit status.
If citation selections must be removed, the repair context/example are removed
as well; stale selected-source joins are not left behind. Oversized approved
scope fails before a model reservation. These limits add no calls or retrieval.

## Evidence and limits

`test_repair_context.py` replays actual saved malformed calls 10 and 12 and the
valid calls 11 and 13, checks field paths/shapes, unit-specific findings,
selected-source separation, poison/large input omissions and a valid nonempty
example. A different SQLite/Temporal grouped premise using saved sources is a
held-out presentation case; its scripted finding is not a semantic truth oracle.
Sixteen generated payload fingerprints from the prior frozen runtime protect
legacy and policy 1/2/3 without opt-in across exploration/draft/audit/repair.

`test_repair_context_lifecycle.py` executes both malformed recoveries, a single
same-ID correction, whole-replacement coverage rejection, genuine fixture
reserve/submit operations, original deadline/accounting, cached-result restart
and exact accepted artifact hashes. Actual loopback HTTP captures serialized
requests, including Unicode pressure. Scripted acceptance proves mechanics;
the real failed pilot and independent final rejection stay unchanged.

Source and packaged tests cannot establish real-model semantic improvement.
A frozen successor still needs a separately approved, exact bounded live pilot
and whole-report acceptance. This implementation grants no live or installation
authority and does not reopen closed allowances.
