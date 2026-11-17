# Package verification bounds

`verifyPackage(destination)` retains schema 1, inventory/content hashes, optional
`100644`, `100755`, and `100600` modes, installed SDK versus lock comparison, and
`true` on a valid package. Ordinary distributable files need no private ownership
or permission requirement. The builder and manifest format are unchanged.

The verifier rejects packages exceeding these finite bounds. Limits count exact
raw bytes, UTF-8 path bytes, or slash-separated relative path components.

| Item | Limit |
| --- | ---: |
| Manifest JSON, including whitespace | 8,388,608 bytes (8 MiB) |
| Each installed SDK/lock JSON | 2,097,152 bytes (2 MiB) |
| Listed payload files | 32,768 |
| Distinct parent directories, excluding root | 32,768 |
| Relative path | 4,096 UTF-8 bytes; 64 components |
| Each listed payload | 2,147,483,648 bytes (2 GiB) |
| Sum of declared payload bytes, excluding manifest | 8,589,934,592 bytes (8 GiB) |
| Payload read/hash buffer | 65,536 bytes (64 KiB) |

These bounds were selected against accepted terminal package specimens on
2026-11-17: 826,036-byte manifests, 3,800 files, 585 parent directories, maximum
117-byte/10-component paths, a 126,650,264-byte largest binary, and 268,207,299
total payload bytes. Lock/SDK JSON measured 44,008/6,511 bytes. Headroom is about
10 times the manifest, 47 times the largest dependency JSON, 8.6 times the file
count, 56 times the directory count, 17 times the largest binary and 32 times
total payload. The separate beta consumer's 1 MiB JSON default does not define
this shared verifier's limit. Full shared-runtime specimens were not supplied;
shared layout/omitted-layout compatibility is covered by focused fixtures, and
future larger packages require revisiting these explicit limits.

All inventory limits are checked before payload traversal and inventory digest
calculation. Payload hashes use one fixed buffer, independent of declared file
size. Only the manifest and the two installed dependency JSON files retain bounded
metadata buffers; the dependency comparison uses bytes from their already hashed
descriptors. Directory enumeration uses one iterator with a one-entry buffer,
accepts only manifest-derived files/directories, and stops at the first extra
entry. At most the allowed entry count plus one entry is inspected. Operating
system path/filesystem limits may reject a package below these ceilings.

Manifest and payload files open read-only with `O_NOFOLLOW | O_NONBLOCK`; platforms
without these flags fail closed. The same regular-file descriptor supplies size,
mode, bytes and SHA256. Reads consume at most the permitted bytes plus one byte
to detect growth. Device/inode, mode, size, nanosecond modification/change times
and link count are compared before/after reading and against a final pathname
`lstat`. Descriptors and directory iterators close on success and failure. Roots
and parent paths must be directories without symlinks; directory/root metadata
changes observed during their inspections also reject.

This is bounded integrity verification for quiescent, access-controlled package
trees. It is not an `openat`/directory-descriptor filesystem sandbox or an atomic
snapshot: a hostile writer with the same UID can swap ancestors between checks,
restore entries between observations, or change a file after its check. Final
component no-follow protection does not extend to every ancestor atomically.
Finite bytes/entries bound work and allocation, not wall-clock I/O on a stalled
filesystem. Checksums detect corruption relative to the supplied manifest; they
do not authenticate a publisher. Source/fixture proof does not qualify a real
host, clean-machine installation, signing, or public release.
