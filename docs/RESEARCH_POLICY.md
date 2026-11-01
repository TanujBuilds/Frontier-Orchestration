# Autonomous research contract version 1

New autonomous jobs may explicitly approve this closed policy:

```json
{"version":1,"finish":"selectors_only","discovery":"search_required"}
```

The harness goal uses `researchPolicy`; its research task inherits the approved
policy and the bridge transports it as `research_policy` in the Python manifest.
Unknown versions, missing/extra policy fields, task overrides and operator use
fail before dispatch. Schema versions and the state database version are separate.
Omitting the policy preserves legacy normalization, approval hashes, task behavior
and reserved requests. Existing jobs are never retrofitted. The selector contract
is not a global runtime default or a model-selectable option.

Each model evidence entry must contain exactly `source_id`, `text_sha256`, `start`
and `end`. Offsets index Python Unicode characters in immutable saved text, not
UTF-8 bytes. A selection must uniquely match an offer in that exact reserved
request, including its full-text hash and range. Quote fields, nested canonical
metadata, mixed entries, booleans as offsets and stale/unoffered ranges reject.
The coordinator copies exact text into a separate canonical artifact, then runs
the existing exact saved-passage validator. Raw responses and source bytes stay
unchanged. A valid empty incomplete report remains possible. Exact provenance
alone does not establish semantic support or independent factual correctness.

Discovery is derived from the same job's reserved search operations, query,
deadline and saved outcome. Status distinguishes requested, attempted, failed
and satisfied. A valid completed empty search satisfies performing discovery;
it does not establish useful coverage. Upstream errors, blocked engines,
malformed results and pending/ambiguous requests remain spent and unsatisfied.
Exact queries are retained for later independent focusedness assessment.
Checkpoint flags, model assertions and seed downloads cannot satisfy discovery.

A complete strict report requires durable successful discovery. During exploration
an unmet requirement yields bounded feedback. Final phases still allow only
finish actions and retain the original last-three-call draft/audit/repair budget.
Exhaustion or deadline produces an explicit partial gap without hidden requests.

The Codex/operator route retains its exact-quote API and zero model dispatch.
Old saved request payloads replay verbatim; identity, approvals, counters and
absolute deadlines never refresh on restart. Current-version restart and legacy
compatibility must be fixture-tested. Downgrading active strict jobs to older
code is unsupported unless separately demonstrated safe on disposable state;
never restore a historical database to regain budget.


## Opt-in support guidance version 2

New autonomous goals may explicitly approve
`{"version":2,"finish":"selectors_only","discovery":"search_required"}`,
which pins `research@3`. Version 1 continues to pin `research@2`; omitted policy
continues to use legacy `research@1`. Old normalized hashes, capability schemas,
reserved payloads, catalogs and active-job behavior remain unchanged. Unsupported
policy versions reject before dispatch. Manifest and database schema versions are
independent of this policy; this change does not migrate or reset state.

Version 2 offers exact sentence/paragraph-aware source ranges where possible,
with conservative incomplete-unit metadata for bounded fallback or cut windows.
Catalog metadata identifies presentation version 2; it is not part of the closed
four-field selector. Completeness describes presentation boundaries, not semantic
support. Multiple real selectors can support one claim. Saved source characters,
UTF-8 hashes and Python-character offsets are never normalized or reconstructed.
Only the actual reserved catalog authorizes selection, including after trimming
and restart. Code and catalog behavior must be pinned to the approved candidate.

Generation and existing draft/audit/repair guidance prefer compact material atomic
claims, preserve conditions and negation, and require sufficient selected evidence
for each assertion. Missing support is handled by narrowing a claim, selecting
additional offered passages or recording an explicit gap. Comparisons and
recommendations separate documented premises, assumptions, design proposals and
qualified inferences. Failure bookkeeping does not establish automatic retry;
local transaction recording does not establish remote idempotency or close a
remote-success/local-crash ambiguity. A proposed lease is not verified fencing.

These are model instructions, not an entailment classifier. The existing report
shape and deterministic acceptance rules remain unchanged. Version 2 receipts add
coordinator-owned quality metadata bound to the finalized claims and source artifact
hashes: provenance status, model support proposed only, independent semantic review
pending and release acceptance not granted. Model/source flags cannot grant review.
Legacy lifecycle acceptance is never reinterpreted as semantic certification.

All original bounds remain: 196608 bytes for the actual serialized HTTP request,
96 offers, 1000 characters per selected quote, 10 evidence entries per claim,
existing source/parser/read/download limits and the final three draft/audit/repair
calls. There is no extra model, verifier, hidden call or expanded budget. Operator
exact quotations and zero-model behavior remain unchanged. Current-version recovery
and old-mode compatibility do not establish safe downgrade of an active v2 job.

Offline replayed reference judgments and scripted provider runs demonstrate bounded
mechanics and known evidence failures; they do not demonstrate a real-model quality
improvement. Independent review of the exact finalized report, selected passages and
original primary sources remains necessary. Full release and personal installation
are not granted by this offline contract repair.
