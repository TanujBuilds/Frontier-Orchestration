# Protected check backends

The coordinator selects a versioned backend. Model text cannot supply a sandbox
profile, implementation factory or execution authorization. A backend identity
is evidence of selection, not evidence that restrictions were enforced.

`codex-sandbox` revision 1 preserves the existing Codex CLI argv, ordered
filesystem configuration, restrictive environment and network-denied policy.
`CheckRunner.verify()` still runs actual private-read, unapproved-write, allowed
output and live-loopback canaries. An unavailable server, timeout or refused
connection does not count as a network permission denial. There is no ordinary
shell fallback.

## Native status: unavailable

`darwin-seatbelt` revision 1 is recognized on Darwin arm64 with the actual
`/usr/bin/sandbox-exec`. Its production `execute()` always throws an isolation
pause: verified descendant containment is required. Neither options,
environment variables, backend identity claims nor a successful diagnostic
compiler result can enable it. `assertDarwinSeatbeltContainment()` provides the
same unconditional prerequisite to earlier lifecycle gates.

Disposable tests on macOS 26.6 (25G72), Darwin 25.6.0 arm64, Node 24.22.0/libuv
1.52.1 established native filesystem/network enforcement and actual Chromium
CSV validation. They also reproduced a release-blocking containment defect:
`posix_spawn` can create a detached session even when direct `setsid` and
`setpgid` syscalls are denied. A detached child can reparent and write after its
original process group has been terminated. Killing an original group and
polling a process list do not establish ownership of those descendants.

The common process runner now retains its two-second SIGKILL escalation after
the direct parent closes and, on POSIX, waits up to two further seconds for the
original group to disappear (`kill(-pgid, 0)` must report ESRCH). Permission
errors are retried and never accepted as proof of exit. Failure to establish
group disappearance rejects execution. Tests check the exact owned same-group
child is dead when the result resolves and cannot write after its former late
write deadline. This fixes the ignored-stdio same-group bug; it does not supply
detached descendant containment. Normal successful commands retain their
existing completion behavior.

Native protected execution and the installed end-to-end lifecycle remain
blocked. This release makes no Linux/Windows sandbox claim and does not install
a privileged service, change Codex settings or enable network as a substitute.

## Diagnostic policy compiler

`compileDarwinSeatbeltPolicy(spec)` is pure and returns SBPL plus diagnostic
input evidence. It does not run a process. Owned tests call `sandbox-exec`
through a test-local executor; there is no production raw-execution override.

Its coordinator-owned specification contains:

- `permissions`: the validated version-1 neutral deny-default filesystem and
  disabled-network policy; workspace read and both explicit output writes must
  be present. The legacy broad runtime selectors are accepted as input but are
  translated to the narrower native runtime exceptions below.
- `workspace`, `executable`, `dependencies`, `outputs`: canonical descriptors
  `{path, realPath}`. Paths must be normalized absolute strings without control
  characters or backslashes; aliases with differing real paths are rejected.
  Dependencies must be prepared in the workspace's `node_modules`, and output
  roots are exactly `dist` and `.overnight-output`.
- `readPaths` and `inventory`: approved relative scopes and exact input entries
  `{path, realPath, hash, mode}`. Hashes are SHA-256; modes are `100644` or
  `100755`. Duplicates, secrets, undisclosed files, canonical escapes and
  conflicting deny targets are rejected. Original inventory excludes `dist`,
  `.overnight-output` and dependency trees, consistent with `Workspace.inventory`;
  staged copies use the separate read-only staging contract below. At most
  10,000 inputs and 2 MiB of
  serializable compilation data are accepted; emitted profiles are capped at
  4 MiB.
- `stagedInputs`: at most ten canonical `approved-inputs-*` roots with exact
  inventories matching the approved bytes and executable modes. Staged roots
  override broader output reads/writes: only inventoried files can be read and
  all staged writes are denied.
- `deniedPaths`: lexical and resolved targets `{path, realPath}` of excluded
  files, including existing secret/undisclosed symlink targets. Required runtime
  roots or approved inputs conflicting with those targets fail closed.

The caller must collect realpaths, bytes and file modes from a trusted fresh
snapshot. A pure compiler cannot attest that caller-supplied hashes describe
the current filesystem or prevent a later path replacement. Compiler evidence
binds the inventory hash to file bytes and executable modes, and records the
profile hash; it is explicitly marked diagnostic-only. Production native
execution remains unavailable, so this interface is not a replacement for
`CheckRunner` snapshot protection or a release claim about race-free checks.

Source reads are exact literals, with exact ancestor metadata needed by Node
realpath resolution. Literal `/` is required for current dyld/libignition
bootstrap. Literal workspace-directory read is required by `getcwd`; these
directory literals expose their directory metadata/names, not descendant file
contents. A project package boundary must itself be approved; the compiler does
not allow Node to discover parent projects' `package.json` files implicitly.

Read-only system exceptions are `/System/Library`, `/System/Cryptexes`,
`/System/Volumes/Preboot/Cryptexes`, `/usr/lib`, `/usr/share` and
`/Library/Fonts`, plus the exact canonical runtime executable. They supply
system frameworks, dynamic libraries, cryptex mappings, locale/timezone data
and fonts. Standard `/dev/null`, `/dev/zero`, `/dev/random` and `/dev/urandom`
are readable; only null/zero permit write-data. Prepared dependency trees are
readable/executable. No broad `/usr`, `/System/Volumes/Data`, home, `/var`,
Homebrew, Mach-service or network grant is emitted.

Nested secret basename/extension denies also cover ignored/untracked files
inside dependency and output roots. Symlinks to outside or excluded physical
targets remain denied by the kernel's resolved-path enforcement; exact
canonical input/root descriptors prevent authorizing an alias accidentally.
Profiles use argv arrays and string literals, supporting spaces and both quote
characters without shell interpolation. Temporary profile files in tests are
private and deleted deterministically.

## Evidence and upstream limits

Targeted native tests exercise real permission errors for external/home dummy
canaries, `.env`, Git metadata, undisclosed and ignored files, symlink/firmlink
aliases, outside/input/staged writes, approved source/output/temp/staged reads
and writes, live loopback and a numeric external TCP attempt. Only EPERM/EACCES
from connect counts as network denial. The actual Chromium fixture fails on
incorrect downloaded CSV rows and passes after correcting source while the
protected check and permission profile remain unchanged; its fresh inventory
evidence changes with the checked source revision.

Recheck tooling and runtime assumptions on every supported OS/runtime update.
The local `sandbox-exec(1)` manual marks the command deprecated. Installed
`/System/Library/Sandbox/Profiles/{system,dyld-support,bsd}.sb` describe Apple
private interfaces that may change without notice. The observed Node SIGABRT
with root access denied was resolved by the root-literal requirement explicitly
documented in installed `dyld-support.sb`.

Primary implementation references are Chromium's
[Mac Sandbox V2 design](https://chromium.googlesource.com/chromium/src/+/main/sandbox/mac/seatbelt_sandbox_design.md)
and [common profile](https://raw.githubusercontent.com/chromium/chromium/main/sandbox/policy/mac/common.sb),
[libuv 1.52.1 process spawning](https://raw.githubusercontent.com/libuv/libuv/v1.52.1/src/unix/process.c),
and [Apple XNU spawn handling](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/kern/kern_exec.c).
The latter `main` source corroborates the spawn-attribute mechanism rather than
claiming to match the exact installed kernel revision. Direct syscall denial
does work for direct calls, but libuv's detached flag uses POSIX_SPAWN_SETSID.
Blocking `posix_spawn` entirely also blocks required Node/Chromium fixture
subprocesses. No supported nonprivileged mechanism closing this gap was
established; a future containment facility requires explicit approval and new
timeout/cancellation evidence before this backend can become available.
