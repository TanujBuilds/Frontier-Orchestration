# Owner request intake

Mosaic preserves the exact valid UTF-8 text supplied to its existing HTTP routes,
including characters split across transport chunks, astral characters and combining
sequences. It does not normalize the text.

## Body limits and failures

| Route | Maximum wire-body bytes | Existing format |
| --- | ---: | --- |
| `POST /api/invoke` | 1,048,576 | JSON tool packet |
| `POST /login` | 4,096 | URL-encoded form |

Limits count bytes received in the body, rather than JavaScript characters or a
claimed Content-Length. An exactly sized body is allowed. A completed body over
the limit returns HTTP 413 with `Request body exceeds limit`; it is never
truncated and invoked.

The internal reader copies chunks into one allocation bounded by the route's
byte budget. It retains no fragment list and pulls the next chunk only after
copying the current one. After a complete read it decodes UTF-8 strictly once.
Malformed or truncated wire UTF-8 returns HTTP 400 with `Invalid UTF-8 request
body`. A read failure returns the fixed HTTP 400 diagnostic `Incomplete request
body` when a response is still possible. Neither diagnostic includes request
text, connection keys, paths or stream error details. Disconnected clients may
receive no response. No incomplete body invokes a tool.

A leading UTF-8 BOM is retained. JSON parsing therefore continues to reject a
leading BOM with HTTP 400; the decoder does not silently introduce a new accepted
JSON format. Login retains its existing form parsing and connection-key checks.
An empty reader result remains empty; an empty JSON request remains invalid.

On overflow the reader releases its retained body and drains/discards further
chunks. It leaves the socket available for the 413 response after a completed
request. Stalled reads and drains remain governed by the existing HTTP request
deadline. The server settings remain `requestTimeout=15000`,
`headersTimeout=10000`, `maxHeadersCount=64` and `keepAliveTimeout=1000`.
Node's deadline check scheduling can make observed connection closure later than
the configured request timeout. A stalled incomplete request may receive the
server's HTTP 408 rather than a body error.

## Authentication and authority

The API remains bound to literal loopback. Operator/viewer keys, trusted proxy
origins, Host/Origin checks, browser CSRF, content-type checks, viewer tool
restrictions and route ordering retain their existing rules. Body decoding grants
no authority. Preparation still creates only an exact reviewable draft; activation,
execution, checks and approval use the existing controls.

## Blocked checkout preparation

The existing `needs_input.issues` objects still contain only `code`, `field` and
`message`. Three prerequisite messages now give an owner a next action:

- `missing_commit` at `project.repo`: the checkout has no resolvable committed
  HEAD. Review and save the intended work through your chosen commit workflow,
  or select a clean checkout with a committed HEAD, then prepare again.
- `dirty_repository` at `project.repo`: staged, unstaged or untracked changes
  need owner review. Save the intended changes through your chosen workflow,
  or select a clean committed checkout, then prepare again.
- `base_mismatch` at `project.baseCommit`: review the current committed base and
  prepare again using its exact HEAD, or omit `baseCommit` to let the existing
  preparation checks resolve it. Any new draft requires its own approval.

These messages execute no repository commands and change no checkout validation,
source, index, commit, manifest, hash, permission or approval. An exact idempotent
replay returns its original draft even if the checkout has subsequently moved;
changed input under that key still conflicts.

## Source regression coverage

`test/mosaic-owner-intake.test.mjs` exercises the production-used reader with
deterministic byte fragments, then the real authenticated API with owned loopback
clients. It covers UTF-8 splits, byte boundaries, strict errors/BOM behavior,
sequential slow reads, reused buffers, many fragments, interrupted input,
completed overflow, stalled normal/oversized requests and authorization guards.
Disposable Git/Store fixtures cover prerequisite guidance, byte/index/HEAD
preservation, exact draft hashes and replay without execution or provider spend.
The existing API and assignment entries additionally exercise the established
transport, safety and preparation contracts. These are source and fixture checks;
actual host, owner-project, provider and installed-package qualification remain
separate.
