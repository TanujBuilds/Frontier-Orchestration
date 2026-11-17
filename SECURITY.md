# Security policy

Status checked November 16, 2026. Mosaic is an experimental source preview. No stable binary release or security-maintenance window is declared. The current source checkpoint is described in [CHANGELOG.md](CHANGELOG.md); local package checks do not establish a public distribution or security certification.

## Reporting a vulnerability

**There is currently no verified private reporting route.** GitHub private vulnerability reporting was checked for [TanujBuilds/Mosaic](https://github.com/TanujBuilds/Mosaic) and is disabled. No security contact address is configured in this policy. Do not assume GitHub's “Report a vulnerability” flow is available.

Do not post vulnerability details, exploit instructions, credentials or private task data in a public issue, pull request or discussion. Ordinary bug reports may use the issue template only when the reproduction is safe to disclose and contains no sensitive details.

**Unresolved maintainer action:** establish and verify a private reporting channel, then update this policy with the working route and supported-version/response expectations. No response-time commitment is currently offered. Until that channel exists, this policy cannot provide a confidential submission path.

When a private route is available, a useful report should identify the affected source commit or archive version, macOS version/architecture, component, expected boundary, observed behavior and a minimal redacted reproduction. Use disposable data. Keep raw task databases, personal paths, endpoint/key values, tokens and authentication files private; share only the bounded evidence needed through the verified channel.

## Relevant boundaries

Mosaic handles task context, model endpoints, private credentials, worktrees, check processes and review evidence. A local worker does not imply that app-based review stays local. Remote workers and API reviewers receive the approved context through their own data/usage paths. See [architecture](docs/ARCHITECTURE.md).

Exact approvals, protected check commands, runtime fingerprints and durable execution ownership are security-relevant contracts. Uncertain work retains holds; deleting state or switching versions does not establish quiescence. Archive checksums detect changed bytes but do not authenticate the publisher. Actual host accounts, clean-Mac behavior and authenticated public distribution remain separate qualification gates.
