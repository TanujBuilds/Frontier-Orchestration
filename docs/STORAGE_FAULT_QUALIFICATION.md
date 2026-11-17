# Storage fault qualification

Measured November 17, 2026 using ordinary Node v24.22.0. The exact baseline was `ddd922cd141bcc1a58f26969f4cc23847f6c955c`, tree `922ed8752b9b6cccd5553b3fe672b6f7deefb115`. Its original **SOURCE_NOT_READY** measurement remains negative evidence: no production repair was included in that measurement. A separately isolated repair candidate adopted the original three files byte-for-byte and reproduced the same three failures before any production edit.

At that exact baseline the [storage entry](../test/mosaic-storage-faults.test.mjs) ran 11 finite specimens: eight passed and three failed, with no skipped or TODO cases. The existing `test/harness-state.test.mjs` passed all 19 tests. After the catch-only `Store.tx` repair, all 12 storage specimens and all 19 existing state tests passed, with no skipped or TODO cases. The twelfth specimen is a focused rollback-cleanup regression; every original specimen and assertion remains. These focused results do not represent integration acceptance or full-suite qualification.

| Specimen | Observed baseline result |
| --- | --- |
| Direct SQLite control | Actual `node:sqlite` errcode 13, database or disk is full; failed insert left no row. |
| `Store.tx` | Primary errcode 13 was replaced by a rollback errcode 1 at the caller. |
| `Store.command` | Same diagnostic defect; no partial record, event or command result committed. |
| `Coordinator.saveRequest` | Same diagnostic defect; reservation stayed spent and reserved, with no result or saved event. |
| Journal open ENOSPC / EACCES | Each rejected before writing; prior bytes and memory stayed exact, action count zero. |
| Journal partial write | A real 23-byte prefix remained after injected ENOSPC; reload retained the incomplete tail and refused append without recovery or truncation. |
| Journal sync after full write | Caller rejected and memory retained its prior event count; reload saw the complete new event. Visibility does not establish durability. |
| Memo completion write | One action executed and its effect remained; only operation.started was logged. No replay was attempted. |
| atomicJson write / rename | Prior destination stayed byte-identical; the unique partial or complete temporary file remained. |

The SQLite control used a four-page ceiling (16,384 bytes). The three production specimens used 29 pages (118,784 bytes), two pages above their initial count, with one fixed 3 MiB payload. A pass-through observer on each owned connection recorded the original SQL error and subsequent rollback error without injecting SQLite failures or changing SQL/results. SQLite automatically rolled back the transaction on exhaustion; the unconditional rollback in `Store.tx` then obscured the actionable primary error.

Before/after/raw read-only reopen comparisons retained every row in records, submissions, commands, events, requests and sqlite_sequence. Goal/task approval hashes, limits, mode, deadlines, saved/failed requests and event prefixes stayed exact. The Store transaction/command specimens retained an explicitly unknown failed request and its uncertain task owner. The saveRequest specimen retained its still-running owner's unresolved reservation; it did not clear an unknown task to make saving possible. No model request was dispatched.

The repair changes only the `Store.tx` rollback catch. It rethrows the identical primary value, preserving its SQLite code/message and any existing cause. A rollback failure is attached as a non-enumerable `rollbackError` when the primary accepts that property; the Store retains the last cleanup failure as transient `lastRollbackError` even when the primary is frozen or primitive. This is one in-memory diagnostic, not persisted recovery state. It does not clear reservations, release ownership, authorize replay, or certify rollback success.

The three actual SQLite exhaustion specimens now assert exact primary object identity, `ERR_SQLITE_ERROR`/errcode 13/message, and the separate errcode 1 rollback object. They retain every original before/after/reopen and accounting assertion, and verify failure sends no commit notification while SQLite's automatic rollback permits a later empty transaction. The added child-local cleanup specimen throws a frozen primary with an existing cause and injects a rollback failure before SQLite executes cleanup. It verifies nested writes remain uncommitted, depth returns to zero, no commit listener fires, and a new transaction is rejected while the SQL transaction remains active. Only the disposable fixture explicitly rolls back before testing subsequent successful commit notification; production adds no recovery mechanism.

Both focused commands used the pinned ordinary Node v24.22.0 runtime:

```sh
node --test --test-concurrency=1 test/mosaic-storage-faults.test.mjs
node --test --test-concurrency=1 test/harness-state.test.mjs
```

Original negative measurements, fresh unchanged-byte RED, added-regression RED, passing repair logs, SQL diagnostics, database/WAL/SHM and row snapshots, journal bytes, action effect and temporary files are retained privately for ROOT. No failing candidate was committed or pushed. Independent candidate review and ROOT serial integration remain separate steps.

Filesystem faults were injected only in separate owned child processes at the selected journal path/handle or atomic destination's unique temporary path. Every injected hit was asserted and hooks restored in finally. Each child had a 15-second timeout and 256 KiB combined output cap; retained fixtures were bounded to 64 MiB. No filesystem was filled and no global limits, permissions or TMPDIR were changed.

SQLite page exhaustion is real resource exhaustion within a disposable database, not OS disk-full proof. Injected ENOSPC/EACCES is not real disk or ACL qualification. Journal.memo is a legacy project log, not the authoritative Coordinator request ledger; a missing completion entry does not authorize action replay or release an uncertain request hold. Actual disk/permissions, installed/native paths, sleep/reboot, clean Mac, providers and owner projects remain untested here. This contributes bounded evidence toward M056; M039/M051 and release gates remain separate.
