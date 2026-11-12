# Bounded worker execution

Portable provider-policy goals can approve one to four autonomous tasks per
goal. The private `serviceMaxConcurrentTasks` ceiling independently limits the
whole coordinator (default one). Historical goals without a provider policy keep
their single global autonomous slot. Changing configured ceilings/groups requires
quiescence of prepared and active affected work; preparing another goal cannot
raise a service ceiling.

Worker, planner and API-review requests share immutable profile and physical
capacity-group limits across goals. Alias profiles for the same normalized
endpoint must use one group. Configure other aliases of one physical service in
that same group. A distributed service spanning multiple machines is one group.
Denied inference waits dynamically recheck the real ledger without repeatedly
claiming tasks or growing logs. Ledger changes and original deadlines wake idle
scheduling; exact saved replies need no new inference slot. Requests with unknown
remote outcomes retain capacity and spending until an
explicit supported reconciliation proves their outcome. A timeout, cooldown,
local process death, or reported stop cannot refund that reservation.

One coordinator lease supervises bounded per-task runners. Task generations,
unique runner ownership and persisted request pins fence late results. Selected
unavailable workers wait without a fallback; eligible independent work can
continue. Readiness scans and idle wakeups are bounded. Shutdown aborts only the
owning coordinator's transports/check subprocesses, settles its runner maps and
preserves ambiguous request ownership for recovery.

## Candidates and write scopes

Each coding task uses a separate candidate checkout with an execution base
captured before editing. Dependencies require accepted integration, rather than
model completion or review readiness. Overlapping directory/glob scopes and
unknown overlap serialize conservatively. Started unresolved candidates retain
scope through review/integration waits. Native writers participate in the same
atomic scope admission; even a terminal-looking status cannot release an active
native writer before explicit host confirmation. Disjoint scopes can proceed
within the independent task and inference ceilings.

## Canonical integration

Every integration target mutation acquires the canonical Git common-directory
repository lock first, then its integration journal lock. Linked worktrees and
symlink aliases therefore share a lock across goals. Existing Journal locks carry
a random generation token and PID. Recovery requires the recorded process to be
absent (`ESRCH`); time alone never permits stealing a lock. Live, malformed or
ambiguous owners fail closed.

New provider-policy goals without an existing private integration journal share
one checked repository target. The original source checkout remains unchanged.
Each import applies only its approved candidate changes, including executable
bits, then runs protected checks against the combined state. Previously accepted
check contracts are saved with the checked commits and rerun with their original
check definitions and original permissions. Permissions are never unioned.
Candidates with changed content/mode preimages fail with a repair/review reason;
no force overwrite or automatic conflict resolution occurs.

Historical no-policy goals, provider-policy goals retaining the old native
layout without a review policy, and pre-existing private journals keep private
paths and semantics. Private targets remain intentionally independent across
source bases; canonical locks, pending imports, native owners and write-scope
fences still apply between them. Checks-only provider-policy goals can use shared integration. Their mutations still acquire the universal repository lock. An
accepted independent private target cannot silently mix with a shared target:
the incompatible operation fails while preserving the old target and candidate.
Goals approved at the same base share a canonical generation. After prior work
is finalized and quiescent, a separately approved successor can start a fresh
preserved generation at a new source base that contains every prior accepted
head. This also supports finalized private-to-shared transitions. Original goal,
task, deadline, spending, receipt and journal bytes remain unchanged. Inert draft
revisions of terminal goals have no execution authority and do not block later
quiescent configuration.

Successor proof refuses live writers, pending imports, uncertain calls, divergent
or omitted accepted changes, and modified old checked targets. Finalized partial
candidates stay preserved; only accepted commits enter the new base. A recorded
sealed partial target is never reused or moved: its exact saved snapshot must
still match, and a fresh generation leaves its unaccepted edits behind. Seals without
saved executable-mode proof fail closed if current modes differ from the committed
preimage. Goal hash/version,
project and live deadline are rechecked after asynchronous proof and at the
transactional target pin, so a concurrent approval change cannot strand the goal.
An incompatible activated goal that has not started work can use its existing exact
`prepareRevision`/`activateRevision` path to approve the new base while preserving
its original deadline and limits. It need not attempt to finalize an empty core
goal. Mosaic does not silently rebase or migrate those histories.

A pending import fences all other goals for that repository until the same task
recovers or performs the existing supervised inverse-import repair. Git commit
and journal checkpoints survive a process crash before SQLite acceptance; retry
reuses the exact saved commit, limits and deadline. A passing isolated candidate
or successful application alone never counts as accepted combined behavior.
Executable-bit changes during checks are rejected before acceptance.

## Evidence limits

The stage-14 tests use disposable Git repositories, loopback provider fixtures,
barriers and individually owned subprocesses. These prove source behavior for the
exercised transitions. They do not establish live provider, installed-host,
clean-machine, multi-day, platform packaging, signing or release reliability.
No actual service/Spark configuration is changed by these fixtures.

An expired taskless approval with no project artifacts or unresolved ownership
does not permanently own the physical baseline or freeze later quiescent
capacity settings. Known closed planner history remains preserved and spent;
unknown requests, pending operations, tasks, dirty/orphan project artifacts or
planner/native owners still fail closed. A never-activated empty draft can lack
physical baseline ownership while its prepared policy continues to fence
capacity/settings. These inert proofs are rechecked after awaits and at target
pin; explicit activation during preparation invalidates the exemption. Old goal
bytes, deadlines and approvals are neither refreshed nor implicitly activated.
