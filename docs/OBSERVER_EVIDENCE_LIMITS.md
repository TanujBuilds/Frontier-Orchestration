# Observer review evidence

The observer reads saved coordinator evidence. It does not reserve reviews, run
providers, retry requests, integrate candidates, or change approvals, deadlines
or spending. Viewer access remains restricted to the existing observer reads.

Beta snapshots retain the legacy `goal.reviewPolicy` string. The additive
`goal.reviewSelection` describes the approved common-review source: a supported
host ID, or an API provider ID, revision and requested model. Invalid approval
hashes produce an unknown selection. Provider endpoints, credentials, raw verdicts
and candidate files are excluded from this projection.

`task.review` describes the current saved ticket. It checks approval, task,
generation, rubric, checks, saved candidate identity and reviewer bindings. A
completed acceptance also requires the matching saved acceptance receipt; API
acceptance requires its bound completed provider response. Stale, invalidated or
replacement evidence cannot supply acceptance for the current candidate.
Integrated review status additionally requires the matching integration receipt.
Revision requests, exhausted budgets, expired reservations and unresolved API
requests remain distinct from acceptance. Reservation expiry and host-report
freshness are evaluated on each poll, including otherwise cached snapshots.

The terminal identifies host review as Codex, Claude Code, Cursor or Antigravity
according to the approved selection. API review is labeled as API review and its
provider. Saved review events use their ticket's historical source rather than
assigning every review to Codex. Legacy goals retain their existing labels.

Activity has separate provenance: coordinator state, reported host progress, or
captured API response. Only a fresh host reviewer report after reservation can
describe active review. A reservation alone does not prove activity. A requested
model is a configured identity; an API-reported model remains reported, and an
unreported model remains unknown. Host token accounting remains unavailable.

Provider token totals count only nonnegative safe integers. Zero is known usage;
missing, negative, fractional, string and unsafe values are unavailable. Partial
totals retain their missing-request count. If adding otherwise valid totals
would exceed the safe integer range, the aggregate is unavailable and marked
`aggregateOverflow`. API reviewer usage is separate from worker usage. No cost or
savings estimate is inferred.

This is saved-evidence observation, not a fresh filesystem check or review
authorization. A snapshot does not prove an unchanged working directory, live
host/model discovery, actual owner-project usefulness, clean-Mac support or
release readiness. Owned fixture tests establish only these source behaviors.
