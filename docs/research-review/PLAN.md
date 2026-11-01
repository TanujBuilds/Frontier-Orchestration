Offline implementation approved November 1, 2026. The live-validation proposal remains UNAPPROVED and must not be activated. Original approval is retained in the private authority ledger.

# Research proposal recovery and bounded semantic review — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or separately authorized subagent-driven-development) for a future approved implementation. This document is PROPOSED ONLY. It authorizes no implementer, provider/host call, pilot, installation or publication.

**Goal:** Preserve usable evidence through format recovery and allow bounded independent findings to reach the same research job before its terminal semantic decision.

**Architecture:** Keep the existing report format, adapters, coordinator and local evidence validation. A new opt-in contract separates an untrusted repair proposal, a protocol-valid frozen candidate, an independent-review ticket and terminal accepted artifacts. The coordinator owns native-review limits/authorization; the worker owns bounded execution and cannot grant its own acceptance.

**Tech Stack:** Existing Node24/SQLite/MCP and pinned Python; no new provider/dependency/scheduler/model runtime.

**Spec:** DIAGNOSIS_AND_ARCHITECTURE.md in this directory. All choices below are recommendations requiring approval, not previous owner decisions.

## Global constraints

- Never change the current failed candidates, official citations, identities, deadlines, spent counters, closed unused allowances or release gates. New work requires a new explicit approval and fresh frozen candidate.
- Preserve legacy, policy1 and policy2 normalized manifests/hashes, registered capability schemas and reserved request bytes. Existing records keep existing semantics.
- Keep196608actual serialized HTTP JSON bytes,96offers,1000characters per quotation,10evidence entries per claim and current source/parser/download bounds. No fabricated offsets, automatic evidence promotion, keyword entailment checker or source-text authority.
- Same fixed whole-report semantic rubric: at least five useful supported material facts spanning requested families; every material comparison/recommendation premise supported as cited; useful conditional recommendation; conditions/negation/antecedents retained; explicit proposals/gaps; no local-durability-to-exactly-once-remote inference. Do not require benchmarks or an implemented queue merely for labelled proposals.
- Proposed future validation caps: one task≤7200seconds within a fresh4-hour parent;20total DeepSeek requests/30searches/50downloads/0planner/0questions; at most2explicit independent semantic review assignments,1semantic corrective round, and2model requests after its first review when capacity permits. All retries count. No replacement pilot or installation/coding pilot in that validation envelope.
- Keep DeepSeek-only free of Codex fallback. Initially enable the new reviewed contract only in explicitly approved collaborative research. No always-on frontier supervisor.

## Review focus

1. Valid-looking citations and inference labels that do not support the actual subject, premise or configuration.
2. A malformed non-claim section erasing useful selections, or a newer bad proposal accidentally falling back to an older accepted artifact.
3. Stale review acceptance surviving a changed report, source/catalog/rubric hash or failed full replacement.
4. Restart, deadline, stop or ambiguous native/provider outcomes duplicating requests, resetting budgets or clearing unknown ownership.
5. Alternate controls (generic coding review, questions, model flags, legacy routes) bypassing the new research gate.

## Task 1: Declare the opt-in contract and exact boundaries

**Files:** modify src/harness/contracts.mjs and .agents/skills/deep-research/scripts/research_state.py; create .agents/skills/deep-research/scripts/research_review.py for focused pure proposal/review-contract helpers; add test/research/test_review_protocol.py and contract tests in test/harness-research.test.mjs.

**Consumes:** Existing normalizeGoal/normalizeTask/normalize_manifest and existing policy1/2/capability snapshots.
**Produces:** Explicit policy3 -> research@4 -> catalog2 mapping through pure `policy_parameters(policy) -> {strict, support, catalog_version, requires_review}`; existing report shape unchanged. Proposed nested policy field `review` has exactly version1, role=independent_operator, maxRounds2, maxRevisions1, maxCorrectionModelCalls2 and rubricSha256. Effective task model/deadline caps remain authoritative and may be narrower. Reserve native review before dispatch in a dedicated coordinator ledger, distinct from pending DeepSeek provider operations.

- [ ] Add RED cases: unknown new contract rejects today; old legacy/policy1/2 normalized hashes and reserved bytes stay byte-identical; new rubric/review caps alter approval hashes; malformed/expanded limits reject; new policy rejects in DeepSeek-only and operator zero-model legacy routes.
- [ ] Add the closed version-specific contract without adding new defaults to old normalized objects. Explicitly choose catalog2 for policy3; do not assume policy number equals catalog version.
- [ ] GREEN focused contract cases plus existing strict/support/legacy compatibility tests. Record actual results and commit.

## Task 2: Retain a repair proposal independently of whole-report validity

**Files:** modify research_worker.py and research_review.py; add test/research/test_proposal_recovery.py with a new read-only copy of the actual saved first-finish response/catalog fixture. Existing tests and historical fixtures remain protected.

**Consumes:** Exact reserved model operation/result, source snapshot and offered selector set; new contract from Task1.
**Produces:** `build_repair_proposal(raw_report, sources, offered, request_ref) -> Proposal` where Proposal has immutable operation/result/catalog binding, bounded individually valid claim/evidence projection, whole-report errors and per-claim unavailable/error records. A fully canonical valid candidate stays a separate object. Proposal fields never establish support or acceptance.

- [ ] RED end-to-end fixture: replay latest first finish with its actual two malformed contradictions, not a prevalidated seed. Capture the next model request. Assert8claim records and original C4/C8 selections remain visible with explicit global errors; no semantic acceptance or valid canonical report is minted. Current code delivers null/null and should fail this case.
- [ ] Add RED case for valid candidate followed by invalid audit: both raw outcomes remain immutable, newer failure stays active, and neither erased context nor stale-candidate finalization is allowed. Add stale/malformed evidence and forged review fields.
- [ ] Consume Task1 policy_parameters in the worker’s explicit new-contract branch, retaining old reserved-payload early return and legacy behavior. Store the proposal reference before whole-report validation can discard its context. Preserve source/selector binding through allowlisted projections. Keep old bad synthesis out of unlabelled writer context; retain raw full prose in its immutable diagnostic artifact. Do not silently enlarge selections or promote nearby text.
- [ ] GREEN both actual failure paths, existing valid-draft/heldout tests and wire/omission cases. Under pressure omit whole cards with explicit gaps; absence must not masquerade as successful reconstruction. Commit.

## Task 3: Hold a frozen valid candidate for independent review and one correction

**Files:** modify research_worker.py, research_state.py and research_cli.py; extend research_review.py; add test/research/test_review_lifecycle.py.

**Consumes:** Protocol-valid candidate from Task2, exact source/catalog hashes, fixed rubric hash, current manifest/deadline/counters, trusted operator review tickets.
**Produces:** Nonterminal `awaiting_semantic_review`, immutable candidate descriptor, bounded feedback receipt, same-job correction and hash-bound finalization intent. Proposed backend RPC actions are fixed data-only proposal_export and review submission—not arbitrary commands.

- [ ] RED: protocol-valid but semantically negative scripted candidate does not become terminal completed before independent acceptance. A bound review0 finding can queue correction on the SAME job. Review1 acceptance binds the whole replacement. Review1 rejection, no review capacity or no model/time capacity ends unaccepted.
- [ ] Implement a candidate descriptor binding canonical report SHA, source artifact SHA, reserved offer digest, request/result provenance and rubric SHA. Export it read-only for review. Awaiting review releases DeepSeek execution ownership only after observed quiescence; waiting native review must not be described as active or uncertain DeepSeek inference.
- [ ] Apply operator feedback only to the exact current candidate. Bound findings identify a claim or section/index, issue class, rationale and optional references to actually offered passages. Corrections run through existing provider reservation and report validation. The model writes revisions; the reviewer does not rewrite official prose.
- [ ] Require review reserve before native dispatch and immutable decision afterward. Native ambiguity stays spent in the coordinator review ledger. Remote mirrored feedback/ticket history is bounded and idempotent; native review reservations are not confused with worker HTTP requests or refunded during restart.
- [ ] Add crash tests around proposal write, review reserve/result, correction reserve/result, accept/finalization intent and export. Preserve original timestamps/identity/counters. A review decision and finalization intent must commit before deadline; later recovery may only replay that committed local intent. Stop/uncertain execution cannot be bypassed.
- [ ] GREEN lifecycle/restart/deadline tests and old unreviewed contracts. Commit. No real reviewer/provider is called in these fixtures.

## Task 4: Connect the existing coordinator/MCP and preserve all acceptance boundaries

**Files:** modify src/harness/research.mjs, src/harness/tools.mjs and src/harness/coordinator.mjs; add test/harness-research-review.test.mjs. Update scripts/release-readiness.mjs and docs/release-readiness/receipt.schema.json only for the explicit new contract. Update existing installed-package fixture tests, not old result artifacts.

**Consumes:** Backend nonterminal proposal and review actions from Task3; coordinator's durable command/record/event primitives and operator authentication.
**Produces:** One proposed `research_review` tool with a closed action=reserve/submit union. Reserve takes taskId/candidateHash/rubricHash/idempotencyKey and returns a ticket. Submit takes ticketId plus exact binding and accept/revise/reject/findings. Tool remains marked mutating. It records review budget and operator-captured evidence but launches no hosted model itself.

- [ ] RED: collecting a proposal cannot make task accepted. Generic task_review cannot accept/requeue this new research contract through its coding `phase=attempt` logic. question_answer, model/source verification flags, a stale ticket and wrong hash cannot bypass the research gate.
- [ ] Route explicit research reserve/submit through the adapter, keep exact IDs/ownership, display actual waiting/review/correction events, and mark task accepted only after backend exports its bound accepted candidate. Keep captured operator events distinct from native-reported progress and unknown usage.
- [ ] For policy3 readiness, require the current accepted pre-final review receipt and exact bindings. Preserve policy2 behavior and failures. No checker status grants installation authority.
- [ ] GREEN CLI/SDK fixture flow: prepare/activate/submit fixture, proposal export, reserve, negative review, correction, reserve, accept, finalization and restart/receipt replay. Deny development imports in standalone package tests and suppress bytecode in all children. No new dependencies or native host inference here. Commit.

## Task 5: Final checks, one review and prospective validation handoff

**Files:** documentation/proof only; build a NEW immutable package from clean reviewed source. Never modify current candidate-d725d4c or its seal.

- [ ] Self-review against all16REGRESSION_CASES.json entries. Every mechanical assertion must map to an owning test above. Human semantic labels are fixture data, not a runtime truth oracle. Keep at least two protected heldout domains and positive conditional/proposal cases.
- [ ] Run focused RED/GREEN, then one final npm test, pinned Python research suite and affected standalone CLI/SDK/package/restart tests. Observer regression only where affected by new status/events. Record actual counts; repeat broad suites only for a new change/failure.
- [ ] One independently authorized Sol source review after checks pass; resolve material findings with a reproducing test. Freeze source, package, template/dependency hashes and rubric before any future live spending.
- [ ] Under a NEW explicit validation approval, use the separately budgeted native fixture host to prove the new mutation path first. A fixture failure stops real research spending. No policy weakening or mutation relabeling.
- [ ] Only then prepare NEW goal/task IDs/manifests/hashes for the single proposed live job. Do not resume old jobs or transfer unused calls. Cap task.seconds by fresh remaining parent time, retaining bridge-derived not_after; no invented goal absolute-deadline fields or DB date edits.
- [ ] During that future job, deliver independent findings before finalization and re-review any whole replacement. Preserve raw candidates, requests, feedback, review reservations/usage and all failures. Two terminal collections and real quiescence remain required. Same fixed semantic rubric; no requirement or citation rewriting after output.
- [ ] Stop at any failed required gate, unaccepted correction, exhausted limit or unavailable reviewer. No replacement, installation or coding pilot is included in this validation proposal.

## Plan self-review

The actual null-candidate path is owned by Task2; semantic closure by Task3; stale-hash/bypass/mode safety by Tasks1/3/4; wire and untrusted input by Tasks1/2; whole-replacement/positive-usefulness/deadline/restart behavior by Tasks3/4; installed provenance and new-host applicability by Tasks4/5. This is one narrow research lifecycle change using existing infrastructure, not a new report system. All implementation details above are proposed. Code-review/native-test contexts and two semantic reviews need explicit new budgets; underlying native inference counts and billing cannot be assumed from context counts.
