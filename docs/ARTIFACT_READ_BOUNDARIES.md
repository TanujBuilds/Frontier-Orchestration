# Saved artifact read boundaries

`Artifacts.list` registers only the task's saved proposal, verified report names,
and saved PNG screenshot references. `Artifacts.read` requires an existing artifact
ID and preserves the saved byte length and SHA-256 check. IDs still bind the task
to the canonical filename; public responses retain the name, type, byte count,
checksum and `/api/artifacts/<id>` URL without exposing the filename. Repeated
references produce one catalog entry.

Both methods read through one descriptor opened with `O_NOFOLLOW` and
`O_NONBLOCK` where the platform provides them. They validate that descriptor as a
regular file, bind its device/inode/mode/size/modification and change timestamps
to the named file, and read at most 32 MiB plus one sentinel byte. Data over 32 MiB
is rejected. Exact-limit and empty files remain valid. No pathname `readFile`
reopens the validated file, and the descriptor closes on success or failure.

The canonical state-root path and its ancestors down to the artifact are checked
for symlinks and non-directory ancestors. Before returning bytes, the methods
recheck the root's canonical target, named ancestor device/inode/mode identities,
the final named file, and descriptor metadata. Observed replacement, growth,
truncation, content changes, unsafe file types and I/O errors reject the current
artifact before its bytes can be served or saved as a verified record. A rejected
read does not alter its saved record. Earlier independently validated catalog
entries may already have been recorded if a later candidate fails.

This is change detection around a descriptor-bound, finite read, not an atomic
filesystem snapshot or a portable `openat`/`openat2` containment guarantee. Node's
pathname open can traverse intermediate ancestors. A hostile actor can perform
transient ancestor swaps and restore them between observations, or change bytes
and restore observable metadata on a filesystem with insufficient timestamp
resolution. There is also an unavoidable interval after the final observations.
Hard links are not rejected. The state directory must remain owned and protected;
this code does not authorize reading arbitrary attacker-controlled filesystems.
Platforms lacking either open flag have that weaker OS protection; validation
still rejects observed unsafe types and changes. No universal nonblocking
behavior is promised for unusual devices or remote filesystems. The validated
platform fixtures cover ordinary local files and owned POSIX FIFOs.

`Artifacts.safe` remains a pathname validation helper for existing callers; a
returned string alone does not bind a later read to a descriptor. The stronger
read guarantees apply to `list` and `read`.

The focused boundary tests call the actual production class and a real Store in
finite child processes. A child-local module resolver substitutes only this
class's filesystem dependency with an owned-fixture wrapper. Native filesystem
operations still perform the reads, swaps and descriptor errors. There is no
global filesystem patch or production test hook. Tests cover cap/cap-plus-one,
controlled growth, identical-byte final-name and ancestor swaps before open and
after reading, same-size changes, symlinks, directories, FIFOs, a FIFO swap,
missing files, read errors, catalog preservation and safe siblings. Opened OS
descriptors are checked for closure. These are deterministic fixture checks,
not live-provider, host, installation or release qualification.
