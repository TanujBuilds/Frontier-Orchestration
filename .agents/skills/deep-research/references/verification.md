# Verification status

2026-10-28: local implementation and offline validation. **Not yet live-ready.**

- SQLite, reader, search transport, report protocol, worker, CLI and process-death
  recovery have offline tests. The model HTTP adapter is exercised against a
  local fixture server. These are not DeepSeek research results.
- Independent code review found malformed-link replay and exhausted-counter
  recovery issues; both reproduced before fixes and have passing regressions.
- Official skill frontmatter validation passed.
- Installed-skill forward-test passed: two fixture jobs, duplicate submission,
  idle-watcher SIGKILL/restart, checksummed collection and byte-identical repeat
  collection. Counters and deadlines remained unchanged. This exercised workflow
  mechanics, not research quality or active-transfer interruption.
- Combined suites passed: 75 Python research tests and 92 existing Node tests.
  The Python suite includes an actual process exit after saving a model HTTP
  response, followed by successful replay without a duplicate completion call.
- Existing DeepSeek API advertised the configured model, then returned the
  expected closed-protocol action in one transport-only diagnostic. Provider
  reported 116 total tokens. No searches or research were done in that probe.
- Pending: authenticated Spark SSH, SearXNG deployment, two search passes at
  least 30 minutes apart with independent relevance inspection, ten-page reader
  gate, real DeepSeek report with five inspected claims, and Spark completion
  after disconnecting the Mac submission session.

Current rollout status is pending SSH authentication. Do not describe this as a
working unattended Spark deployment until the remaining evidence is recorded.
