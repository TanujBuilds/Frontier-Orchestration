# Reviewer identity in assignment preparation

`assignment_prepare` summarizes the normalized, approved reviewer policy alongside the exact draft hash. Preparation saves a draft; it does not activate a goal, run checks, call a provider or dispatch a reviewer.

With an explicit host review policy, `summary.roles.reviewer` names the approved host (`codex`, `claude-code`, `cursor` or `antigravity`) and `reviewSource` is `host`. The role description names that host rather than assuming Codex reviews every mode.

With an approved API review policy, `reviewer` and `reviewSource` are `api`. `reviewerReference` contains only the configured reviewer ID and revision, using bounded, sanitized display strings. The description identifies that reference as an API reviewer. Provider display names, endpoints, credentials, model names and private context are not copied into the reviewer summary. Recognizable secrets and control characters are removed from display text, so a sensitive reference may appear redacted; the exact approved policy remains bound by the returned goal hash.

`providerVerification` remains `unverified`. A prepared reviewer reference does not establish model identity, inference, availability or usage. The existing approved wait fallback remains in force; summary text grants no fallback, activation or dispatch authority.

The mode's `planner`, `workers` and `review` fields retain their existing meanings. In particular, `review` is the mode's pinned review mechanism, while `reviewSource` identifies the selected policy source. Historical goals without a review policy retain all four legacy role summaries. DeepSeek-only remains checks-only, and Codex-only continues to reject API review.

The focused regression uses the public MCP transport, real preparation/normalization and disposable Git repositories. It checks all supported host IDs, all three API transports, legacy summaries, prohibited policies, sanitization, stable hashes/limits/checks, idempotent retries and absence of execution. It is owned-fixture evidence, not proof of a real host account, provider call or deployed installation.
