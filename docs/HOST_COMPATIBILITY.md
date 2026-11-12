# Host review compatibility

## Portable candidate status — November 12, 2026

Stage 16 guided setup uses the selected host as the default reviewer and allows
an explicitly configured API reviewer. Native protected checks bind the separate
`darwin-seatbelt@2` artifact fingerprint and literal installed Node path; a
non-Codex host has no hidden Codex login or executable requirement. Historical
goals keep their original policy, and native revision 1 remains unavailable.

| Component | Version/protocol | Evidence level | Date | Evidence and limits |
|---|---|---|---|---|
| Codex connector | stdio / pull review | fixture-tested | 2026-11-12 | Host schema, registration preview and SDK protocol fixtures; actual host version/account NOT RUN for this candidate. |
| Claude Code connector | stdio / pull review | fixture-tested | 2026-11-12 | Same coordinator contract and manual registration preview; actual app NOT RUN. |
| Cursor connector | stdio / pull review | fixture-tested | 2026-11-12 | Configuration and protocol fixtures; disposable managed registration differs from a real app. Installed composition evidence is recorded separately in the release handoff. |
| Antigravity connector | stdio / pull review | fixture-tested | 2026-11-12 | Configuration and protocol fixtures; actual app NOT RUN. |
| OpenAI-compatible worker | Chat Completions JSON/SSE | fixture-tested | 2026-11-12 | Loopback transport, identity, routing, repair and capacity fixtures; no particular vendor/model quality or live availability claim. |
| Optional reviewer | Chat Completions, Responses, Messages adapters | fixture-tested | 2026-11-12 | Strict structured review and durable reservations; live provider accounts NOT RUN. |
| Native checks | Darwin arm64 / seatbelt revision 2 | fixture-tested | 2026-11-12 | Accepted stage 15 actual OS/kernel/Chromium source execution. Stage 16 extracted-package results require their own receipt. |
| Linux/Windows distribution | — | unsupported | 2026-11-12 | Outside this release's platform scope. |

For every real host in the new portable setup path, setup emits an exact manual
snippet and records manual/unprobed status. The supported host interfaces do
not provide the required atomic compare-and-swap operation.
It does not overwrite a running app's settings through a best-effort file
rename. Uninstall preserves manually configured and unrelated entries. Isolated
fixture homes use a separately owned adapter, whose tests do not establish safe
writes against real app processes. Configuration saved, protocol discovered,
host connected and host reviewed are distinct evidence states.

Actual app versions, auth, background lifecycle/wake behavior, clean macOS
account setup and live-provider review remain NOT RUN. A closed host retains
its review inbox; no API fallback occurs because it disconnects. See
[release evidence](PORTABLE_BETA_RELEASE.md) for the current candidate boundary.

The dated stage 12 account below is retained as historical evidence. Its
statement that native checks await stage 15 describes that earlier stage.

Portable-beta stage 12 provides one durable coordinator and pull-based review
contract for Codex, Claude Code, Cursor and Antigravity. The source and SDK
fixtures exercise configuration previews and MCP behavior; they do not certify
any actual installed app or model. No host credential files are read by these
adapters. API reviewer credentials and billing are separate from an app login.

## Configuration references

Checked November 11, 2026. Exact installed product versions remain untested;
mutable vendor documentation must be rechecked before an installed pilot.

| Host | Configuration path and supported route | Evidence |
|---|---|---|
| Codex | `codex mcp add mosaic-beta -- /absolute/path/to/mosaic mcp`; Codex owns TOML serialization. Local CLI 0.167.0 `mcp --help` and `mcp add --help` were read without reading its settings or auth files. | Local CLI help, normalized CLI-registration fixture, SDK stdio fixture. [Official MCP reference](https://developers.openai.com/codex/mcp). |
| Claude Code | User scope in `~/.claude.json`, `mcpServers` entry with `type: stdio`, `command` and `args`; preview also supplies `claude mcp add --transport stdio --scope user mosaic-beta -- /absolute/path/to/mosaic mcp` as argv. | Documented schema, mixed JSON/file fixtures, SDK stdio fixture. [Official MCP reference](https://code.claude.com/docs/en/mcp). |
| Cursor | `~/.cursor/mcp.json`, merge one `mcpServers.mosaic-beta` stdio entry. Project `.cursor/mcp.json` is another vendor-supported scope; stage 12 previews the personal path only. | Documented schema, mixed JSON/file fixtures, SDK stdio fixture. [Official MCP reference](https://cursor.com/docs/mcp). |
| Antigravity | `~/.gemini/config/mcp_config.json`, merge a `mcpServers.mosaic-beta` entry with `command` and `args`. Vendor also documents workspace `.agents/mcp_config.json`; use the installed surface's raw-config manager to confirm its actual location. | Documented schema, mixed JSON/file fixtures, SDK stdio fixture. [Official MCP reference](https://antigravity.google/docs/mcp?app=antigravity). |

Only stdio is advertised by Mosaic's host registry in this stage. Vendor support
for HTTP, SSE, WebSocket, hooks or notifications does not establish Mosaic
support for those paths. SDK tests identify the simulated client by host name;
they are the same actual MCP protocol client, not four installed coding apps.

## Review and lifecycle

The active main conversation discovers tools, calls `review_inbox` with bounded
paging, inspects exact checked evidence, reserves the complete binding and
submits a strict structured verdict through `review_submit`. Review acceptance
and protected integration are separate operations. Mode policy remains the
coordinator's authority. Historical protocol actor `codex` is the host actor
alias and `deepseek` is the API worker alias; the aliases do not identify a
model or provider. Other-host reported model aliases carry `reported`
provenance. Unknown host model identity and token usage remain null. A correlated legacy
agent reconnect preserves its saved no-host registration/hash even when the
upgraded service now supplies trusted host inference; explicit conflicting
host/model/task/role claims still reject.

A closed or disconnected app is not guaranteed to wake. Its inbox and ticket
persist in SQLite, including through process restart; return to the main
conversation to pull pending review. This integration never guarantees an
automatic native subagent or background review. An API reviewer must be
explicitly selected and separately authenticated. There is no paid fallback.
Host-reviewed overnight work can wait for the host to return. Protected check
execution still uses the existing Codex sandbox until stage 15; these connectors
do not establish Codex-free execution.

## Preview and ownership

`mosaic host-preview --host codex|claude-code|cursor|antigravity` emits a read-only
JSON preview and manual instructions. It does not inspect or change personal
host settings. `previewRegistration({paths,launcher,existing})` accepts an
explicitly supplied parsed snapshot; previews contain the new owned entry and
hashes rather than unrelated config contents. Commands use argv arrays, with
shell quoting only for display. Existing host credentials stay host-owned.

`applyRegistration(preview, {io})` requires an explicit configuration/receipt
adapter. No default file writer or host CLI executor is installed in this
stage. The caller's adapter supplies `read`, `compareAndSwap`, `readReceipt`,
`writeReceipt` and `removeReceipt`. Codex uses a normalized CLI-registration
snapshot (`registration` plus opaque `unrelated` data), so Mosaic never edits
TOML itself. JSON hosts use the parsed full document. The adapter must implement
`compareAndSwap(value, target, {expectedHash, ...commandMetadata})` as one atomic
comparison and replacement: return `true` only when the current canonical JSON
SHA-256 equals `expectedHash` and the replacement succeeds; return `false` on a
conflict without writing. An atomic file rename or a reread followed by a write
is insufficient. An adapter unable to guarantee this must use the manual path.
Tests use injected memory CAS and a single-process-owned temporary-file fixture;
there is no claim of a safe writer against noncooperating actual app processes.

A preview binds the prior config hash, intended entry, exact command argv,
target and receipt path. Apply records pending ownership before writing and
marks complete only after reading back the intended entry. An interrupted apply
may resume the same preview; a changed config or changed owned entry blocks it.
Apply and uninstall use conditional updates, so an intervening config edit
rejects and preserves both that edit and the recoverable ownership receipt.
Uninstall removes only the matching owned entry and preserves unrelated/later
settings. A foreign entry with the same name is never overwritten. Full
interactive host selection, actual managed registration and migration are
stage 16 work; the existing interactive Codex setup remains a compatibility
path and is not an implicit selection of another app.

Private schema-1 settings may explicitly add `host: {id, options: {}}` for the
trusted service host context. Options are strictly enumerated (none in this
stage). The existing Codex setup now saves that explicit host selection; older schema-1
Codex settings remain readable and their trusted codexPath supplies the Codex
default for fresh service preparation. Persisted goals retain their own policy
bytes. A non-Codex host can
load settings without pretending to possess Codex host authentication; the
separate sandbox dependency still applies to coding checks.

## Fixture scope

`test/mosaic-pb12-hosts.test.mjs` covers four registration paths, malformed
configuration, unrelated config preservation, spaces in paths, stale/tampered
previews, foreign/changed entries, interruption/retry, selective uninstall,
neutral host metadata, and fresh stdio clients through disconnect/restart.
The stdio server fixture scripts one saved consultation in a disposable database;
no provider is contacted. It exercises the same Dispatcher and ReviewService as
normal MCP calls. Real protected coding/check/integration behavior is verified
by the stage's separate integration tests. Personal settings, actual app
lifecycle and clean-machine installation remain release gates.
