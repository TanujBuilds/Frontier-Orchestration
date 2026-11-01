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
