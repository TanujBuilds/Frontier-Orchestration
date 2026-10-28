# Frontier Harness Implementation Plan

Goal: Deliver docs/HARNESS.md with concrete passing evidence, not activity alone.
Architecture: Node24 SQLite parent coordinator; preserve backend stores; stdio MCP
and authenticated loopback dashboard; bounded actor-specific adapters and learning.
Spec: docs/HARNESS.md. The approved conversational plan is summarized there.

## Global Constraints

Keep existing runtime configuration unchanged. Preserve historical jobs, spent
limits and original deadlines. No automatic main merge/push/publication. Private
configuration stays ignored. Fixtures and live evidence must be distinguishable.

## Review Focus

- Crash between intent and backend side effect must not duplicate work.
- Unknown remote ownership cannot silently permit another DeepSeek dispatch.
- Learned text cannot expand authority or weaken checks.
- Mode restrictions apply to planning, review, clarification and maintenance.
- Yield and takeover preserve real file state and original request spending.

### Task 1: Contracts and registries

Interfaces: normalizeGoal/normalizeTask and digest; Registry validates/version-pins
capabilities, modes and workflows. Fifth mode is data, not a scheduler edit.
Write failing test/harness-contracts.test.mjs, observe RED, implement contracts
and registry, observe GREEN. Command: node --test test/harness-contracts.test.mjs.
Commit the spec, plan and tested contracts.

### Task 2: Durable state and scheduling

Interfaces: Store transactions/idempotent commands; Coordinator goals/tasks,
reservations, questions/review, dependency/priority queue, controls and ownership.
Write test/harness-state.test.mjs RED; implement SQLite and transitions GREEN.
Verify restart/duplicate/uncertain ownership and spending in process tests.
Command: node --test test/harness-state.test.mjs. Commit.

### Task 3: Execution adapters and modes

Interfaces: bounded adapters step(task,context) returning durable action/outcome;
worker drives one step, reserves before request, reconciles effects on restart.
Harden cooperative cancellation/yield and research absolute deadlines.
Write test/harness-adapters.test.mjs RED; implement adapters GREEN; run research
regressions. Command: node --test test/harness-adapters.test.mjs. Commit.

### Task 4: Review and integration

Interfaces: integration.prepare/accept/takeover/finalize; review decisions and
review-agent reservations in coordinator. Separate worker/integration ownership.
Write test/harness-integration.test.mjs RED; implement transaction recovery GREEN.
Command: node --test test/harness-integration.test.mjs. Commit.

### Task 5: Bounded learning

Interfaces: outcomes/candidates/evaluation/promote/retrieve/quarantine/rollback;
protected evaluator owns evidence, no caller-provided boolean certifications.
Write test/harness-learning.test.mjs RED; implement scoped FTS/versioning GREEN.
Command: node --test test/harness-learning.test.mjs. Commit.

### Task 6: Dashboard, MCP and installation

Interfaces: CLI/stdio tools/HTTP invoke same coordinator commands; personal skill,
snapshot installer, LaunchAgent and uninstall preserve config and data.
Write protocol/security/control tests RED; implement surfaces GREEN. Browser
1280/390, trusted-control and installed runtime forward tests. Commit.

### Task 7: Live proof and final review

Run all original and new suites. Run docs/HARNESS.md pilots and record receipts.
Complete Spark search/reader gates and disconnect collection proof when auth works.
Independent whole-branch review, fix significant findings RED/GREEN, full suite.
Install only validated runtime, record deployment pending where a gate is blocked.
Do not label complete with missing live proofs. Keep branch local for review.
