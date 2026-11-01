# Installation and rollback preparation — proposed, unactivated

Prepared 2026-10-31 Pacific. These commands are a reviewable runbook. They were not executed against personal installation, remote services, or pilot jobs. Final promotion remains conditional on all release gates, separately authorized live pilots, independently checked primary claims, and the actual installed phone/restart checks. Do not infer authorization from this document.

Confirmed source interfaces: `src/harness/{package,cli,store,api,planning}.mjs`, `.agents/skills/frontier-harness/{scripts/harness.mjs,references/operations.md,references/compatibility.md}`, and `.agents/skills/deep-research/{scripts/research_state.py,deploy/deep-research.service.template,references/operations.md}`. Recheck the final combined revision and candidate hash before executing. Never overwrite an existing package directory.

## Candidate and private bindings

Use exactly one immutable new version directory containing four sibling skills plus one shared runtime. Select the reviewed final `VERSION`, `EXPECTED_CONTENT_HASH`, `NODE`, `STATE`, `PROVIDER_CONFIG`, `LAUNCHER_CONFIG`, `LOGS`, `PLIST`, `BACKUP`, and prior package/config bindings explicitly. Values must be absolute. Private machine paths, model endpoint/model ID, SSH target, trusted Tailscale origin and keys do not belong in this portable runbook.

Verify both strict inventory and the independently recorded content hash:

```sh
node --input-type=module -e 'import {verifyPackage} from "./src/harness/package.mjs"; await verifyPackage(process.argv[1]);' "$VERSION"
node --input-type=module -e 'import fs from "node:fs/promises"; const m=JSON.parse(await fs.readFile(process.argv[1]+"/package-manifest.json")); if(m.contentHash!==process.argv[2]) throw Error("Wrong approved package"); console.log(JSON.stringify({sourceCommit:m.sourceCommit,sourceDirty:m.sourceDirty,contentHash:m.contentHash,files:m.files.length}));' "$VERSION" "$EXPECTED_CONTENT_HASH"
```

The private launcher config is `{ "dataDir": "STATE", "runtimeRoot": "VERSION/runtime" }`. The provider config retains the already configured model service, pinned Python/research bridge, and approved native host settings. Add only an explicitly verified `observerOrigins:["https://EXACT_PRIVATE_DEVICE.ts.net"]` entry if phone activation is approved. Do not infer trust from a suffix or allow wildcard origins. Keep configs outside the immutable version, mode0600. Keep API operator and viewer keys distinct in the same private state directory across restart; never transfer the operator key to a phone.

No existing personal skill is overwritten without inspecting and preserving its binding. Expose all four versioned siblings together under the host's skill root using symlinks to `VERSION/skills/{frontier-harness,frontier-collaborate,frontier-deepseek-only,frontier-codex-only}`. A single private launcher binding selects the one runtime. Preserve unrelated personal delegation/research/queue skills and configurations.

The local CLI help verified the registration shape; after approved installation:

```sh
codex mcp add frontier-harness --env "FRONTIER_HARNESS_CONFIG=$LAUNCHER_CONFIG" -- "$NODE" "$VERSION/scripts/harness.mjs" mcp
codex mcp list
```

Do not claim this refreshes an already open desktop chat. Refresh/restart the actual host as needed, then discover real MCP `tools/list` and required `agent_register`, `agent_report`, `agents_list`, `help_link`, and `native_start(layout=candidate_v1)` schemas. A registration record is not host invocation evidence. No model is required for read-only tool discovery.

## State backup and compatibility

Both current coordinator and research stores use SQLite `user_version=1`; they accept versions0/1 and reject unknown versions. Both use WAL. Coordinator uses FULL synchronous transactions. Research schema2 refers to a MANIFEST format and does not mean database version2. Optional task ceilings likewise do not migrate the database. Equal database versions alone do not establish semantic backward compatibility; forward-test the actual previous runtime against a disposable copy of current records.

Before binding a new runtime, ensure workers are quiescent through their authorized controls. Preserve any uncertain request owner; a stopped local process does not prove remote completion. Do not delete lease rows, refresh a deadline, reset request counters, or resubmit exhausted jobs.

Back up each SQLite database using SQLite's backup API, with its worker quiescent or a consistent online backup. A bare copy of the database file can omit committed WAL. Preserve associated artifact directories, current configs, skill bindings, MCP entry and unit definitions in a private backup. Keep credential material outside portable evidence and do not emit it in reports. Hash the backup and save `PRAGMA user_version`, integrity check, logical record identities, exact approved hashes, deadlines, request IDs/statuses/counters, operation IDs and event cursor. The fixture rehearsal proves consistent committed-WAL backup and rejection of stale spending restore; it does not claim application migration compatibility.

A rollback normally selects the previous immutable CODE package while retaining the CURRENT state/config/keys. First rehearse it on a disposable backup copy. If schema or record behavior is incompatible, stop with preserved state and prepare a forward-compatible recovery; do not restore an older database that erases post-backup spending, reservations, task identities or outcomes. A historical snapshot is evidence and disaster-recovery input, never spare model budget.

## Mac service and recovery

Render `com.frontier.harness.plist` with `renderLaunchAgent({node:NODE,entry:VERSION+"/runtime/src/harness/cli.mjs",root:STATE,config:PROVIDER_CONFIG,port:4332,logs:LOGS})`. Precreate mode0700 state/log directories; lint with `plutil -lint "$PLIST"`. The generated plist uses literal argv, RunAtLoad, KeepAlive only after failure,30-second shutdown and the single loopback coordinator. Use a separate fixture label/port for a disposable LaunchAgent rehearsal; do not start a second writer for the same state.

After final approval:

```sh
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl print "gui/$UID/com.frontier.harness"
node "$VERSION/scripts/harness.mjs" status --root "$STATE"
```

For an existing installed label, cleanly stop/bootout its old definition, verify actual worker exit/quiescence, and bootstrap the reviewed new definition. Never use `bootstrap` over an unrelated existing label.

Restart proof: save service PID/owner, read-only goal/task hashes/deadlines/counters, pending reservations, authentication-key HASHES and event cursor. With no executing remote request, run `launchctl kickstart -k "gui/$UID/com.frontier.harness"`; wait for a NEW PID/owner and health. Compare every identity/deadline/counter/request outcome, key hash and exact finalized-receipt replay; verify no new provider reservation or changed package inventory. Save actual before/after artifacts. Never infer success from PID change alone. If a request was in flight, preserve uncertainty and use the original exact-identity recovery path; no retry refund.

Rollback commands after compatibility passes: stop service through its exact installed CLI, `launchctl bootout "gui/$UID/com.frontier.harness"`, verify quiescence, atomically rebind skill/launcher/MCP/plist paths to the prior approved package, then bootstrap it with the CURRENT state. If this is the first personal install, rollback removes only the newly introduced bindings/unit and retains its new state/artifacts. No prior personal bindings have been proven by preparing this runbook.

## Research service

Render the reviewed `deep-research.service.template` using separate immutable `REMOTE_ROOT`, existing `REMOTE_DATA`, and private `REMOTE_CONFIG`; do not modify SearXNG, model containers, authentication or runtime. Preserve the prior user unit and exact source hashes, existing data, operation history and approved manifests. Ensure the candidate includes the pinned requirements and compatible venv; source-path updates alone do not prove installed imports.

After all gates and activation approval, use the already authenticated owner shell:

```sh
systemd-analyze --user verify "$RENDERED_UNIT"
install -m 600 "$RENDERED_UNIT" "$HOME/.config/systemd/user/deep-research.service"
systemctl --user daemon-reload
systemctl --user enable --now deep-research.service
systemctl --user show deep-research.service --property=ActiveState,SubState,MainPID,FragmentPath,UnitFileState
loginctl show-user "$USER" --property=Linger
```

Never enable a watcher until its existing queue has been inspected and any queued live work is explicitly authorized. A watcher may dispatch immediately. Rollback stops the watcher, confirms no active/uncertain remote inference, restores the previous unit CODE/config binding while retaining CURRENT research.sqlite3/artifacts, daemon-reloads and resumes only previously approved work. A prior one-shot pilot's transient systemd unit is not a final watcher.

## Private phone observer

The private proposal contains the actual device DNS origin resolved from a fresh host-context Tailscale JSON read. At that observation Serve had no routes and no Funnel. Recheck before mutation; never overwrite unrelated routes, reset Serve globally, or enable public Funnel. Keep coordinator bound to127.0.0.1. After gated activation, the proposed command is `tailscale serve --bg --https=443 --set-path=/ http://127.0.0.1:4332` with the EXACT private HTTPS origin in `observerOrigins`.

Actual mobile acceptance: authorized tailnet device resolves HTTPS; viewer-only key logs in; Secure/HttpOnly/SameSite cookie is set; `/observer` loads at phone width; evidence expansion/filter/reconnect work; invalid Host/Origin and forged/multiple proxy headers fail; viewer mutation API and `/legacy-console` fail with403; phone actions cannot approve/stop/steer work. Existing localhost/fixture browser checks are useful but do not certify this real route. If rollback is needed and the snapshot was empty, remove only this exact Serve route/port; never issue global `serve reset` or alter Funnel.
