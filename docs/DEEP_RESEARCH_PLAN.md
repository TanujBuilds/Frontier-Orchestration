# Deep research implementation plan

Approved 2026-10-27. Build a Spark-independent approved research backlog using
SearXNG, a bounded public page reader, DeepSeek and SQLite. Codex reviews only
when requested; the runtime never invokes Codex. Existing coding jobs and model
serving settings are outside this change.

The owner subsequently requested offline implementation while AI Top 2 is
unavailable. Build and test the remaining skill now; keep the live search gate,
Spark deployment, real research pilot and disconnected-Mac proof pending.

## Deliverables

1. Private loopback ARM64 SearXNG deployment and reproducible two-pass search gate.
2. Bounded HTTPS HTML/plaintext reader, saved evidence and extraction provenance.
3. Exact approved manifests, sequential SQLite jobs, durable request reservations,
   worker ownership, stop/resume and preserved deadlines/counters.
4. DeepSeek search/read/finish loop and cited Markdown/JSON reports, bounded
   self-check and one repair. Defaults: 7200 seconds, 30 searches, 50 downloads,
   20 model calls including three calls reserved for finalization.
5. Portable CLI/SSH submission and checksummed collection, personal skill,
   offline integration/recovery tests and independent forward-testing.

## Validation

Run the existing Node suite and Python tests. Exercise actual local HTTP
fixtures, process death and concurrent ownership, not just mocked return values.
Perform one independent final review and skill forward-test. Live acceptance
requires two ten-query Spark passes 30 minutes apart, eight relevant successes
per pass, eight usable pages out of ten, then a real durable-queue comparison
report and disconnected submission/collection. Record pending checks honestly.
