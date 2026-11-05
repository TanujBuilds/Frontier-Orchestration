# Live-pilot review evidence follow-up

Repair mode remains Codex-only. The separately approved Overnight v2 pilot retains its original IDs, two-hour deadline, twenty coding calls and two reviews per stage. User resumed it after a mode clarification; this is not a budget renewal.

## Verified failure

The first real stage passed starter/core checks and produced more than two files through multiple batches. Codex's first review requested the approved TASK.md and check contents: the coordinator supplied only hashes for these references. The verdict explicitly requested no code change. DeepSeek then requested the same already-supplied files twelve times. V2 inputs omitted the exchange and receipt of the previous read, so repeated requests could produce identical model prompts. The stage reached its twenty-call ceiling. Its candidate snapshot is byte-equivalent to the saved passing candidate; one original review remains.

## Scoped correction

- V2 reviewers receive bounded permitted reference file contents. Implementation reviews include read-only stage inputs; final review includes current source too, because an empty final diff alone does not show previously integrated code. V1 packets remain unchanged. Secret/out-of-scope files never enter the packet. Context that cannot fit the reviewed bounds fails before reserving a frontier review.
- V2 model input includes current exchange and a durable receipt for fulfilled read/apply actions. Requested current file hashes are acknowledged; this does not replace stale hashes or loosen validation. Existing bounded request/exchange/correction policies remain.
- Add operator-only task_review_evidence_retry. It requires exact approved task/result hashes, a quiescent blocked v2 task with a saved revise verdict, unchanged passing candidate, no ambiguous review reservation, and remaining original review allowance. Re-run protected gates. It edits no product files and does not renew attempts, model calls, reviews or deadlines. A durable repair record makes request replay idempotent. The automatic independent reviewer still decides acceptance.

This recovery is a coordinator evidence correction, not native implementation of the pilot or code rescue. If the candidate changed or the remaining review rejects it, keep the original blocker and bounds; do not create fresh task IDs or reset spending. Any later new budget/run requires concrete authority.

## Evidence and remaining gates

Regression tests observed missing packet contents, an indistinguishable repeated read, absent bounded recovery, and empty-final-diff missing source before changes; each now passes targeted verification. Tests cover changed candidate, exhausted/ambiguous authority, same-key replay and unchanged spending/deadlines. Independent review, complete suite, frozen package and quiescent software installation precede any live evidence-only retry. The real pilot is not yet release-complete.

## Verification and independent review

Complete suite: node --test --test-concurrency=4, 702 tests passed, zero failed. Five targeted regressions were observed failing before the fixes and then passing. Independent read-only follow-up review found no Critical or Important issue. No live provider was invoked for this Codex-only repair.

Deferred minor: if a crash occurs after the evidence-repair transaction but before the effect completion record, replay after a pause/deadline may report failure before reading the durable committed receipt. It does not duplicate spending or extend authority. The authoritative saved task/repair record remains inspectable. No claim of perfect post-expiry operation-result replay is made.

Ruling: evidence-only recovery is an explicit operator correction for coordinator delivery failure, not a new coding attempt. It may consume only an already-approved remaining independent review, after proving candidate bytes unchanged and gates passing. Cost if the reason is misdiagnosed: the remaining reviewer may reject the same candidate; no budget or deadline is renewed and no product code is rescued by Codex.

Set-asides: live reviewer acceptance, actual installed quiescence, real-provider behavior and completion evidence remain runtime gates. This code review and fixture suite do not establish them.
