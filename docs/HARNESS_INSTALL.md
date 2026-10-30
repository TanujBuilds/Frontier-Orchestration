# Installation and rollback

This produces a candidate package. Do not activate the owner's final service
before the combined corrected runtime and release gates in
[HARNESS_VERIFICATION.md](HARNESS_VERIFICATION.md) pass. Disposable fixture SDK
calls, skill validation and a configuration file do not establish actual native
host discovery or live runtime acceptance.

## Prepare one version

Use Node24 from the reviewed checkout and a new destination:

```sh
node src/harness/package.mjs --source-root /ABS/REVIEWED_CHECKOUT --destination /ABS/NEW_VERSION --dependencies --offline
```

The exact lockfile and `npm ci --omit=dev --ignore-scripts --bin-links=false` pin
runtime dependencies. `--offline` requires the local cache; cache/dependency
failure leaves an inspectable failed candidate without a valid manifest. Select a
new directory after correcting the cause; no build overwrites a previous version.
A package without `--dependencies` needs its locked dependencies before operation;
it is not a ready-to-run installation.

```text
VERSION/
  SKILL.md, agents/, scripts/, references/, roles/, examples/  (primary compatibility)
  skills/
    frontier-harness/       (shared operations/references/launcher/templates)
    frontier-collaborate/   (thin entry + MCP metadata)
    frontier-deepseek-only/ (thin entry + MCP metadata)
    frontier-codex-only/    (thin entry + MCP metadata)
  runtime/                 (one standalone source + locked node_modules)
  package-manifest.json
```

Expose the complete `VERSION/skills/` root to the host's supported skill discovery
mechanism. Keep siblings together: focused entries link to
`../frontier-harness/references/`. The top-level primary entry and launcher preserve
the old layout and resolve the same runtime; they do not start another scheduler.
Each entry declares MCP dependency value `frontier-harness`, transport `stdio`,
without a URL or explicit-only policy. Discovery/invocation remains normally
available. Do not copy a runtime into each focused skill.

`package-manifest.json` records source commit/dirty state, layout, four skill
names and SHA256/size of reviewed skill data, source and installed dependency
files. `contentHash` hashes that inventory. `verifyPackage()` rejects changed
files, unlisted files/directories, duplicate/traversing paths and every symlink, and checks the installed
SDK against the lock. Checksums detect modification against the saved manifest;
they are not a signature authenticating an untrusted replacement manifest.
Keep a trusted source/package hash receipt outside the package. Role/skill/runtime
tampering and dependency absence are tested.

Reviewed portable sources include the four entry skills, shared references,
three opt-in native role templates, placeholder examples and Python research
bridge. Adjacent private settings, credentials, connection files, databases,
saved project sources and personal skills are excluded. Existing personal
`deepseek-delegate` is not silently vendored or overwritten. The legacy
compatibility reference preserves historical backend routing; old approvals/IDs
must never become fresh harness tasks.

## Python cache policy

The research bridge runs Python with `-B` and `PYTHONDONTWRITEBYTECODE=1`.
The supported `harness_rpc.py` and `research_cli.py` script entrypoints also
suppress bytecode before importing adjacent runtime modules; SSH research CLI
invocations pass `-B` to the configured interpreter. Keep research state,
configuration, sources and collected reports outside the package.

For direct diagnostic commands, use the pinned interpreter with `-B`:

```sh
/ABS/PINNED_PYTHON -B /ABS/VERSION/runtime/.agents/skills/deep-research/scripts/research_cli.py --data-dir /ABS/PRIVATE_RESEARCH_STATE status
```

An ad hoc Python driver that imports packaged modules must itself start with
`-B` (or set `PYTHONDONTWRITEBYTECODE=1` before starting Python). Imported modules
cannot prevent Python from caching their own code before their bodies run; the
runtime does not govern arbitrary external importers. Do not run `compileall` or
install dependencies into a published version.

Package verification still rejects every unlisted file/directory, including
`__pycache__` and `.pyc` files. Existing caches are failure evidence, not an
inventory exception: preserve the damaged version and build a new candidate;
do not remove caches or rewrite its manifest to claim that version stayed valid.

## Private bindings and native roles

Private provider config, auth, state and logs stay outside immutable versions.
Preserve existing files. The launcher accepts
`FRONTIER_HARNESS_CONFIG=/ABS/PRIVATE/local-config.json`, containing absolute
`dataDir` and optional `runtimeRoot` pointing to `VERSION/runtime`. With no
runtimeRoot it resolves this version's shared runtime. Adjacent local-config.json
continues to work for legacy bindings, but is never included in a build. A missing
explicit private config/runtime fails clearly, without falling back to the source
checkout. The source skill alone retains development-checkout compatibility.

Examples contain placeholders only, not verified endpoints or model IDs. Recheck
the configured existing DeepSeek service/model before live operation; never copy
credentials or change Spark runtime settings. `nativeModels` is the private native
model allowlist, `nativeRoleModels` supplies optional per-role defaults. Explicit
unsupported choices fail; unspecified native choices inherit the host. The parent
must use supported host model parameters and record only observed resolution.
Registration metadata does not configure a host model or provider.

`roles/{implementer,explorer,reviewer}.toml` are data examples containing only
`developer_instructions`. Apply only through an explicitly selected native role
mechanism. Do not install them globally or change concurrency, model_provider,
sandbox or MCP configuration as part of package preparation. Read-only role prose
is cooperative, not enforced isolation. Reviewer reservations are a separate
budget of two runs; native implementers inherit available host capacity within
the approved goal budget.

## User service and MCP

`renderLaunchAgent()` in `src/harness/package.mjs` generates literal-argument
plist `com.frontier.harness`. Supply absolute Node, packaged CLI, private data,
private provider config and log paths. Keep private directories mode0700 and
configuration/connection files0600. Verify the generated plist with `plutil`.

After release gates and authorization, register the plist in the current user's
`launchctl` GUI domain. It starts on login/restarts after failure. Deliberate clean
`service_stop` exits successfully and KeepAlive does not immediately restart it;
`launchctl kickstart` starts it again. RunAtLoad can start it at login. Goal/task
pause/stop and native host lifecycles are separate.

Register exactly one stdio server named `frontier-harness`:

```text
node /ABS/VERSION/runtime/src/harness/cli.mjs mcp --root /ABS/PRIVATE_STATE
```

Its bridge reads the private loopback connection file; no bearer key belongs in
host commands or tracked files. Host refresh/restart may be required. Verify actual
MCP discovery and tool schemas, followed by disposable fixture mutations; a health
response/configuration file is insufficient. New collaboration requires
`native_start` layout candidate_v1, agent_register/report/list and help_link;
older runtimes fail the affected launch clearly. Never assume legacy omitted-layout
native_start gives separate checkouts.

Test with disposable private `--root` and fixture provider config first. Package
tests launch CLI/MCP from an unrelated working directory under a loader that
rejects imports of the development checkout. They are SDK fixture tests, not a
claim the current native chat discovered the tools. Stage04 acceptance still
requires independent instruction forward tests on the corrected combined runtime;
Stage07 checks the owner's actual native host in disposable state.

MCP events cannot guarantee a new native turn. Collaborative review, answers and
integration wait while the chat is inactive. Only explicitly selected
`overnight_review` permits bounded check-gated background reviews. One service owns
harness-managed DeepSeek dispatch; external historical clients/startup-scout are
best effort coordination and must not be advertised as universally exclusive.

## Rollback or uninstall

Unload the user service first and verify quiescence. Retain ambiguous request
ownership and spent counters. Restore the prior skill/runtime binding and
matching plist; use the same private state only when schemas are compatible.
Unknown database versions fail closed. Never restore an old database/delete a
lease to manufacture fresh budgets. Record package hash, paths, PID/owner,
preserved deadlines/counters and receipt hashes locally, without credentials.

Uninstalling the service retains private settings, packages, evidence, artifacts
and worktrees for explicit recovery. Spark research has its own lifecycle;
unloading the Mac service does not imply stopping the remote worker.
