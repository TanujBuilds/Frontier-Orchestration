# Owner handoff — November 2, 2026

The waiting fix and its standalone package passed the offline and actual-host
gates. Live research is blocked by unavailable Sparks, and installation has not
started. The approved live allowance is unused: zero research jobs, request
reservations, DeepSeek calls, searches or downloads.

The new `wait` command checks saved task/operation state immediately, waits in a
deterministic process, and rechecks state after events. It reports ready,
attention, timeout, unavailable, cancelled or unsupported state with fixed bounded
JSON. It cannot start/stop/reassign work, change deadlines or expand viewer rights.
The portable launcher requires an explicit root for this command. Two independent
review findings about root fallback and invalid-input exit codes were reproduced,
fixed and covered by the one focused final-diff recheck.

Reviewed runtime source: `b9eb5dd4ce6870035dcb904fe1de7b6d5a75f9e9`.
The new immutable package has 3,774 files, content hash
`53f0edd5b6202e78920ace7b3426a98881b6aec24f25c2bdcc9cfc4e47a4b606`
and manifest hash
`770d1d859fa3004a8cb4cbde07df84844539160faf668da66182641ccc14c4c8`.

Fresh checks: 649 Node tests, 236 source Python tests, desktop/phone-width browser
fixtures, 25 frozen waiting tests, 236 bundled Python tests, 90 frozen authority
regressions, the CLI/SDK correction/accept/restart fixture and three synthetic
readiness routing cases. Development production imports were denied during
standalone checks. Package inventory/pins stayed unchanged and no Python bytecode
was added. Synthetic accepted/live-labelled samples remain fixtures.

The one actual Sol host fixture used 6 MCP calls and 0 event waits in 27.738s,
within the externally monitored 12-call/2-wait/180-second ceilings. It inspected an
already accepted fixture and prepared/activated/submitted a separate unexecuted
Codex-only control. Mutation annotations remained false and global configuration
was unchanged. There were 7 coordinator API reads/calls including the MCP startup
catalog read, and zero coordinator inference requests. The earlier fixture used
251 MCP calls including 229 event waits, but exercised a larger lifecycle; this is
an honest scope-specific comparison, not a universal speed or token-savings claim.
Exposed host usage was 226,800 input tokens (205,440 cached) and 761 output tokens;
billing and underlying inference count are unknown.

The live preflight timed out on configured Spark SSH before any remote command
started. The Mac was online in Tailscale; both Spark peers were reported offline,
and the existing model metadata endpoint was unreachable. No authentication,
model/search runtime or network policy was changed. Exact normalized proposed
goal/task hashes, unchanged question/scope/policy/rubric and fresh package pins
are saved privately; nothing was activated or staged.

A supported narrower operational ceiling of 18 model calls enforces the approved
15-call exploration maximum while retaining two correction slots inside that
ceiling. Initial draft/audit/repair uses at most three calls; after all 15
exploration calls only one initial finalization call remains before the cutoff.
Two slots from the original maximum of 20 are closed unused and nontransferable.
The frozen-worker adversarial fixture verified these limits; no provider was used.

You can inspect the feature map and run the packaged `--help` now. Using `wait`
requires an explicitly selected existing approved state root and active
coordinator. This delivery does not install a personal service or wake inactive
Codex chats. The [feature map](FEATURE_MAP.md) separates implementation, fixture,
live and installed evidence for each feature.

Next actions:

1. Restore Spark availability. If continuing inside this goal's original deadline
   (22:31:57 UTC November 2), recheck ownership/runtime/pins before the same
   approved, still unactivated pilot. After that deadline, obtain a new bounded
   continuation decision; do not reset an old deadline or spend a closed ID.
2. Execute the one exact bounded research job, with independent whole-report
   review before finalization and at most one same-job correction. Failed quality
   blocks installation; no replacement follows automatically.
3. Only after live quality and applicable pre-install gates pass, apply the
   existing conditional installation approval to concrete CURRENT-state
   checkpoints. Installed coding/native-host and physical-phone gates need their
   own applicable evidence/allowances; no extra pilot is authorized by this handoff.

Full release remains INCOMPLETE. Historical failed reports and closed allowances
remain unchanged; fixture success does not turn them into accepted live results.
