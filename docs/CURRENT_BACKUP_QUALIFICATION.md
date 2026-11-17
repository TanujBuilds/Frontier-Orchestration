# CURRENT backup qualification

On 2026-11-17, bounded offline fixtures qualified the existing
`backupCurrentDatabase` helper against the real Coordinator/Store at source
`ddd922cd141bcc1a58f26969f4cc23847f6c955c` (tree
`922ed8752b9b6cccd5553b3fe672b6f7deefb115`), using ordinary Node v24.22.0.
No production implementation changed.

The new `test/mosaic-current-backup.test.mjs` entry covers:

| Case | Observed result |
| --- | --- |
| Real Store with an open writer and committed WAL | Exact ordered records, submissions, commands, events, requests and SQLite event sequence match the read-only backup and unchanged source. A main-file-only specimen lacks the distinctive WAL event. |
| Approval, accounting and ownership | Goal manifest/hash/version/mode, exact approval, original deadlines and caps, task hashes/checkpoints, three spent reservations, saved response, known not-dispatched failure and unknown outcome remain exact. The uncertain task retains its owner. Reservations simulate accounting; no model runs. |
| External artifact reference | A real Artifacts catalog/read verifies ID, hash, size and public URL. SQLite retains its file reference; the separate report stays unchanged and is absent from the backup directory. |
| Receipt and access | Returned/disk receipts agree, checksum matches, integrity is `ok`, schema version is 1, database/receipt permissions are 0600 and directory permissions are 0700. |
| Existing destination | Refused without changing the prior files or receipt. |
| Overlap and symlinks | State-directory overlap, a source symlink and an output-parent symlink are refused while source rows and owned sentinels remain unchanged. |
| Small non-database source | Fails with a fixed bounded diagnostic and no successful receipt. Source bytes and partial output are retained for inspection; no recovery is attempted. |

The representative snapshot contains 11 records, four submissions, five commands,
19 ordered events, three requests and one SQLite sequence row. Its main file is
81,920 bytes, committed WAL 498,552 bytes, backup 110,592 bytes and external report
38 bytes. Physical main/WAL/SHM sizes and hashes are recorded separately from
logical snapshots. SQLite may create WAL/SHM bookkeeping files during read-only
inspection; their byte identity is not the consistency contract.

All three new tests and the two existing named backup/privacy callbacks passed.
The existing entry was filtered to those callbacks; this is partial source-fixture
evidence. Every new case has a 20-second timeout; qualification commands use a
60-second outer limit. Fixture database/copy files are bounded to 8 MiB, artifacts
to 64 KiB and total retained fixture evidence to 64 MiB. The measured fixtures are
well below those limits. Tests retain failures; a lane-owned evidence directory
can also retain successful runs through `MOSAIC_CURRENT_BACKUP_EVIDENCE_ROOT`.

This helper creates a SQLite backup only. Retain external artifacts and any other
referenced files separately. `restorationSupported` is false: no restoration,
replay, refunds or ownership clearance was performed. Corruption recovery,
interruption/sleep/reboot, current-owner and clean-Mac proof remain unproven.
This contributes bounded evidence to M055; M036/M053 and real host, provider,
native execution and public release gates remain separate. ROOT owns source
integration, full qualification and formal acceptance.
