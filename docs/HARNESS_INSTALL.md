# Installation and rollback

Do not activate the final personal service before the release gates in
[HARNESS_VERIFICATION.md](HARNESS_VERIFICATION.md) pass. Preparing a candidate
package and exercising a disposable fixture state do not activate a real backlog.

## Prepare a version

Use Node 24. From the reviewed checkout, create a new empty destination:

```sh
node src/harness/package.mjs --source-root /ABS/REVIEWED_CHECKOUT --destination /ABS/NEW_PACKAGE --dependencies
```

`--offline` uses the existing npm cache. Dependencies use the exact lockfile and
install scripts are disabled. The package includes the skill, standalone source,
MCP dependency and research bridge. `package-manifest.json` records source
revision/dirty status and source-file checksums. Keep earlier packages for rollback;
never overwrite a previous destination. Check `verifyPackage()` before activation.

Use a disposable `--root` and a private fixture provider config first. Run the
packaged MCP entry and fixture workflow independently of the checkout. For live
use, private provider settings stay outside the portable package. The skill's
private `local-config.json` binds `dataDir` and the chosen package's `runtimeRoot`;
the latter points to its `runtime` directory. Preserve existing private settings.

## User service

`renderLaunchAgent()` in `src/harness/package.mjs` generates the literal-argument
plist for `com.frontier.harness`. Supply absolute Node, packaged CLI, private data,
private provider config and log paths. Keep private directories at mode0700 and
configuration/connection files at0600. Verify the generated plist with `plutil`.

After the gates pass, register the plist using the current user's `launchctl`
GUI domain. It starts on login and restarts after failure. A deliberate clean
`service_stop` exits successfully and is not immediately restarted by KeepAlive;
use `launchctl kickstart` to start it again. A login may start the service through
RunAtLoad. Persistent goal/task pause and stop controls are separate.

Register the packaged stdio MCP entry with the host:

```text
node /ABS/PACKAGE/runtime/src/harness/cli.mjs mcp --root /ABS/PRIVATE_STATE
```

The bridge reads the private loopback connection file; do not put its bearer key
in the host command or a tracked file. Verify actual MCP discovery and mutations,
not just a health response. Test a controlled owned-process restart against a
disposable fixture goal before any approved live backlog. Record package hash,
service paths, PID/owner, preserved deadlines/counters and receipt hashes locally.

## Roll back or uninstall

Unload the user service first and verify quiescence. Retain ambiguous request
ownership and all spent counters. Restore the prior skill/runtime binding and
matching plist, then start that version against the same private state only when
its schema is compatible. Unknown database versions fail closed. Do not restore
an old database or delete a lease to manufacture fresh budgets.

Uninstalling the user service does not remove private configuration, packages,
SQLite evidence, research artifacts or worker checkouts. Preserve them for audit
and explicit recovery. Spark research has its own service and lifecycle; unloading
the Mac service must not imply stopping that remote worker.
