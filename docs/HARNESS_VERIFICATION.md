# Harness verification — 2026-10-28

Release is **incomplete**. The implementation is on the isolated `codex/harness`
branch; it has not been merged or published. Installed service recovery and the
Spark research gates remain required.

Tested runtime: Node 24.22.0, SQLite 3.53.4, MCP SDK 1.32.2, Playwright 1.64.1,
Python 3.12 and pinned Trafilatura 2.3.1. Actual Mac checks use the existing Codex
CLI sandbox with network access disabled and an enforcement canary.

| Evidence | Observed result |
| --- | --- |
| Extensible policies | A fifth research-only preset registers without scheduler changes, survives restart and rejects coding. Workflow instances atomically pin definitions and map dependencies. |
| Durability | Actual SIGKILL tests preserve reserved/saved requests and planner responses. An integration killed after its Git checkpoint but before SQLite acceptance reuses the exact commit without another model request or review. |
| Independent review and corrections | A fresh reviewer ran 53 selected tests and found eight significant lifecycle/ownership failures. Eleven reproductions failed before corrections; the full corrected suite passes 193 Node and 86 Python tests. Additional coverage checks typed gateway failures and actual SIGKILL after native acceptance but before effect completion, with no second commit. |
| Recovery controls | Research submission holds ownership until remote quiescence; uncertain research can reconcile exact remote identity and counters under the current coordinator lease. Native collection stores remote finalization separately and retries the original operation without another finish request. Stops arriving during checks/collection are preserved. |
| Installed-package fixture | Standalone MCP service, native zero-model work, exact approval, final receipt and tamper detection pass independently of development imports. A separate agent also completed two reviewed fixture consults across restart, preserving counters and idempotency. |
| Final package forward test | After the review corrections, a separate agent used only the standalone package and documented interfaces. Two sequential fixture consults, reviews, restart, exact same-key replay with no new events, receipt/result checksum verification and clean shutdown passed. |
| LaunchAgent fixture | The packaged runtime ran under a temporary user LaunchAgent. SIGKILL of its verified owned PID triggered an actual restart with a different PID/owner and identical saved task, approval and deadline. Replay caused no duplicate task; final receipt passed. The temporary service was unloaded. This does not claim final personal installation. |
| Collaborative live pilot | Three sequential DeepSeek assignments plus concurrent native Codex work, a supervisor question/answer, blocking-priority yield, resumption, independent review, same-task correction and combined checked integration. Fourteen DeepSeek requests; native Codex usage is not measured by this coordinator. |
| Scope correction | The live pilot exposed overly narrow child read permissions for a combined check. An exact new goal version and explicit rebind corrected reads while preserving write scope, task identity, checkpoint, deadline and spending. The sandbox was retained. |
| DeepSeek-only live pilot | One planning request and two coding requests; malformed JSON consumed an attempt. Protected checks and isolated integration passed with no Codex review or fallback. |
| Native takeover | A real DeepSeek partial was stopped after saving edits and before checks. Codex inspected and finished it in a separate integration checkout; the frozen worker snapshot and original counters/deadline were preserved. The first extra probe had a syntax error; its corrected passing result is a checksummed addendum to the preserved receipt. |
| Codex-only live pilot | Native coding plus two actual bounded public-page reads and a cited report. Five claims inspected against original sources. Zero DeepSeek calls; source membership/passage checks and checksummed collection passed. This did not use SearXNG or test remote persistence. |
| Overnight live compatibility | The first pilot spent two reviews and remained partial because the packet omitted enforcement/context/source-cleanliness proof. After fixing that packet and strengthening a protected type check, a fresh pilot passed with one planning request, one coding request and one bounded Codex review. Original spending was retained. |
| Learning live pilot | Real zero-base/exponential-overflow failure → reviewed correction and accepted integration → one DeepSeek proposal → protected regression plus two held-out replays → promotion → a fresh task retrieved that exact version and passed first-attempt checks and integration. Two DeepSeek requests across maintenance and fresh work. This is a narrow procedure-reuse demonstration, not a general improvement claim. |
| Browser controls | Real backend effects for questions, pause/resume, native execution, inert artifact text, correction and archive; keyboard access, reduced motion and 1280/390 layouts. Local notifications preserve useful transitions without repeating unchanged state. |

Machine-specific endpoints, raw pilot records, spending, source text, receipts and
artifact hashes remain in ignored local evidence. Research extraction omitted an
overview-list passage in one page; the validator rejected that unsupported saved
quote, and a corrected finish used an actual saved passage. Failed operations were
not erased.

## Remaining release gates

- Final versioned package, personal skill/MCP registration and Mac LaunchAgent
  installation; independent restart recovery on that installed service.
- Authenticated Spark deployment, CPU-limited loopback SearXNG, two ten-query
  passes at least thirty minutes apart, relevance/primary-source inspection and
  ten-page extraction assessment.
- Real DeepSeek durable-queue research comparison, five original-source claim
  checks, and Spark completion after Mac-session disconnection with checksummed
  collection. The native Codex-only note does not substitute for this pilot.

The model HTTP route works independently of SSH. The outstanding SSH browser
check failure blocks remote installation, not Mac-side inference. No model runtime
settings, weights, SSH policies or public hosting were changed.

Explicit release of stopped native coding preserves its real checkout and retires
that goal's coding workspace. It permits a partial receipt without discarding or
silently integrating unfinished changes; continuing coding requires a separately
approved goal. Unknown remote ownership still holds the shared slot. Reconciliation
does not recreate a missing remote submission or refund requests.

## Bounded research context repair (2026-10-31)

The worker now exposes saved-source ends and repeated-read/search feedback,
retains up to12 source-ID/hash/range records (at most two per source), and presents
up to24000 saved passage characters plus bounded source prefixes. Evicted, stale
or omitted passages are explicit evidence gaps. Seed retrieval diagnostics do
not establish semantic coverage or factual support. The entire new model request
is bounded to196608 serialized bytes using the provider's actual JSON encoding
and shared unchanged completion envelope; oversized approved question/scope
fails before reservation. Previously reserved requests replay their exact stored
payloads across upgrade, including payloads created before this bound existed.
The bound applies to new requests, not retroactive rewriting of old evidence.

Deterministic five-claim comparison and missing-option fixtures exercise this
context. They are not the mandatory live original-source quality gate. Both
exhausted real reports remain partial and unchanged; source permission, exact
saved-quotation checks and the last-three-call draft/audit/repair reservation
remain authoritative. Fresh live research and overnight validation still require
separately approved exact budgets.
