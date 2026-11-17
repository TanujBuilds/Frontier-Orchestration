# Settings migration conflicts

Migration applies the exact approved legacy settings and credential transition.
It retains a snapshot of settings, credentials, intent, legacy recovery data and
receipt across lifecycle and durable phase boundaries. Before continuing a write,
restart or final cleanup, it checks that those records still match. Only its own
successful writes advance the snapshot.

A concurrent edit stops the migration. The newer records and the partial migration
evidence remain available for inspection; migration does not restore an older
snapshot or silently approve a replacement baseline. Conflict messages identify
the record class without including credential values. Startup readiness also checks
the current settings on disk and binds credential identity to the approved intent.
On resume, legacy recovery data must match the original settings hash, any receipt
must match the approved completion record, and the intent must reproduce the same
legacy transition through the preview calculation. A changed record followed by an
interruption cannot become a fresh baseline on the next attempt.

An interruption without a conflict can resume the approved intent. Completed
phases remain compatible with worker and host-only legacy configurations, and a
completed migration does not replay its durable writes. The existing maintenance
mutex, active and stopped approval protection, startup lease exclusion, and restart
outside the mutex remain in place.

`test/mosaic-migration-conflicts.test.mjs` exercises the public preview, apply,
resume and readiness APIs in finite isolated homes. Lifecycle callbacks inject
edits at verification, stop, intent, credentials, settings, completion and restart.
The tests compare the affected files byte for byte after rejection and cover
credential rotation, unrelated credential preservation and interruption recovery.
The selected existing migration tests provide additional compatibility evidence.

These guards detect observed record changes across migration boundaries. They do
not make several files one filesystem transaction or establish protection against
every hostile same-user write between a check and an atomic file operation. Fixture
lifecycle evidence does not establish actual host, service or provider readiness.
