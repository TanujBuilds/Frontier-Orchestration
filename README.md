# Mosaic for Mac

A native Mac window for the installed Mosaic coordinator, based on the owner's Mosaic Desktop Prototype. Version 1.1.0. AppKit hosts the original local HTML/CSS/JavaScript and fonts in WebKit. No Node, Terminal or browser window is required to run the installed app.

## Everyday use

Open **Mosaic** from the Dock or `~/Applications/Mosaic.app`. **Recent** is the first navigation item and the default view for a fresh installation. It shows running DeepSeek assignments, waiting work and recently updated projects across all registered goals; select a row to inspect it. Existing saved views are preserved. Registered work refreshes every five seconds while visible. Closed, minimized or fully obscured windows pause polling. Choose a workspace, inspect assignments, browse the shared timeline or search History. Workspaces correspond to saved coordinator goals; projects and chats without registered work are not automatically discovered.

The inspector separates outcomes, saved changes, protected checks, review and integration. Open the Changes and Evidence tabs to read bounded saved records. Long assignment briefs collapse by default. Native Codex progress is reported and may become old or unavailable; DeepSeek activity is captured by the coordinator. Old progress does not invalidate saved acceptance or integration. Missing usage remains unknown.

**Recent Codex chats** lists up to20 non-archived local interactive chats, ordered by update time, with their source titles and project folder labels. Search by title or project and choose **Open chat** to open that exact existing conversation. A task offers **Open linked chat** only when its registered host correlation contains that actual chat ID and it is in the current chat list; titles/paths are never used to guess a match. **Open Codex** remains the general app launcher. Instructions, mode selection, answers, pause/stop/continue and approvals stay in Codex. A recent or active Codex conversation does not prove a DeepSeek assignment is running; those are separate sections.

`⌘R` refreshes, `⌘1` returns to live work, `⌘2` opens the explicitly labeled fictional design demo, `⌘0` shows the window, `⌘W` closes the window and `⌘Q` quits the viewer. Clicking its Dock icon reopens the same window. Closing or quitting the app does not stop the coordinator or ongoing work.

Motion covers the initial arrival, view changes, inspector opening, tabs, dialogs and button feedback. It follows macOS Reduce Motion. Idle actor panels have no invented activity animation.

## Connection and privacy

The existing personal coordinator must already be installed and running. Native code reads only its current `~/Library/Application Support/Mosaic/state/viewer-connection.json`; credentials never enter the renderer, URL, bundle or logs. The app adds no service, model call, scheduler, public listener, Spark configuration or operator permission.

The renderer is confined to bundled resources. A native allowlist admits four observer reads, reading recent chat metadata, and opening Codex or a cached existing chat ID. Arbitrary paths, commands, URLs, external navigation and redirects are rejected. The current connection is reread for each request, so a replaced viewer key does not require repackaging. Recent chat metadata uses the installed Codex CLI at one of three fixed locations (`~/.local/bin/codex`, `/opt/homebrew/bin/codex`, `/usr/local/bin/codex`). It starts a bounded metadata-only app-server process, sends initialization and a fixed `thread/list` with state-database-only reads, then terminates its own child. No thread is created, resumed or messaged by the reader. Prompts/previews, transcript items and server notifications are discarded natively. The renderer receives only ID, source title, project folder label and update time. Chat reads refresh every15 seconds while visible, with a10-second native cache,10-second deadline,2MiB response cap and forced cleanup if its child ignores termination. Recent chats can remain usable when the coordinator is disconnected, and chat errors preserve the last list without disconnecting Mosaic. This does not change login, authentication, model or network settings.

If disconnected, a previously loaded snapshot remains visible with a warning. A fresh offline launch has no cached history; open Codex to inspect the local coordinator, then retry. Timeline display retains a bounded recent window of up to 500 events, initially scanning the latest 200 raw event positions. Evidence reads stop at 256 KiB and label a larger record as truncated. Private reasoning and live native token usage are unavailable.

## Build and verify

Requires macOS, Apple command line tools and Node 24 for development. The app itself has no third-party runtime dependency. It is built for the build machine's architecture with a macOS 13 deployment target and a local ad-hoc signature; it is a personal build, not a notarized public distribution.

```sh
node checks/adapter.mjs
node checks/surface.mjs
node native/RuntimeTests.mjs
node native/AdapterRegression.mjs
node native/ReviewTests.mjs
node native/RecentRuntimeTests.mjs
node native/RecentReviewTests.mjs
node checks/recent.mjs
node build.mjs
node native/BundleTests.mjs
node native/check-chats.mjs
# Optional: metadata-only query against the installed Codex CLI
node native/check-chats.mjs --live
```

Build runs the native trust-boundary tests, compiles the app, generates its icon, bundles local fonts/resources, signs it and verifies the signature. Protected checks run separately through the existing coordinator sandbox, without weakening that sandbox to compile the Apple SDK. Keep generated `dist/` outside source review.

## Remove this app

Quit Mosaic, drag `~/Applications/Mosaic.app` to Trash, then remove its Dock icon with **Options → Remove from Dock**. That removes the desktop viewer only. Coordinator state, artifacts, credentials, skills and the existing login service remain in place. The earlier coding-core removal utility remains a separate operation.

## Implementation record

- Imported the ZIP into a new source repository; the installed coding-core source and package stay unchanged.
- One Codex-only goal, one native candidate, four-hour goal/two-hour assignment limits, up to two operator decisions, one independent reviewer reservation. No DeepSeek calls.
- Adapter and surface regressions were defined before implementation and observed failing, then passing. Native endpoint/RPC/resource rejection tests likewise failed before the policy implementation and pass after it.
- Evidence pagination/provenance, saved answered questions, native reviewer attribution and legacy worker diffs each received a failing regression before correction.
- Native UI was checked at 1360×850 and 1000×650 content sizes, including demo/live navigation, Changes, disclosures, tab keyboard behavior, saved outcomes and history filtering. Further installation results are recorded outside the bundle in the personal app installation record.

- Final independent review identified partial-check success wording, registration-order progress hiding, and disclosure focus loss. Each was reproduced, corrected and covered by `native/ReviewTests.mjs` (RED→GREEN). Idle polls now avoid replacing unchanged content; unchanged selected inspector nodes survive unrelated updates.
- Fresh-offline provenance was also corrected with a failing regression: no prior snapshot is claimed before one has loaded.
- Final review exclusions: installation/reopen/Dock and rendering require direct verification; public notarization is outside this personal build. Their actual results are recorded in the private installation record.

- Installed verification caught an inherited review notice that named DeepSeek during Codex-only work. Corrected through a same-task revision with a failing mode-specific notice regression; no identity, spending or deadline reset. Saved review waiting states also take precedence over report age.

## 1.1 verification record

- Protected Recent projection cases defined before implementation: global activity ordering, running/waiting separation, terminal and closed goals, fixture exclusion, per-project recency and unknown time.
- Metadata codec rejects malformed IDs and bounds titles/rows; it drops previews/history. Exact chat URLs require a listed UUID and accept no query/prompt. Native bridge rejects unknown parameters and arbitrary URLs.
- Focus identity for individual Open chat buttons and unchanged chat-poll suppression were observed failing before correction, then passing. Chat failures retain cached metadata and do not change coordinator connection state.
- Native transport tests use real child processes for silence (including ignored SIGTERM), malformed output, oversized output, early exit, in-flight shutdown and completion followed by immediate shutdown; callbacks are bounded and owned children must be reaped. Live native metadata query also verifies its child exits.
- The first live native test exposed a blocking pipe read; switching to available data with safe handle lifetime produced a passing live query and cleanup check.
- Independent review found paused goals missing from waiting and a child-cleanup gap when quitting immediately after completion. Both were reproduced before correction; regressions pass. Paused goals remain resumable waiting work, and shutdown kills all owned in-flight or terminating metadata children.
- Independent review and final installed verification are recorded in the private installation record. Earlier closed execution budgets remain closed.
