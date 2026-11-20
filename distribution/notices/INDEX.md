# Supplemental runtime notices

Portable packages built with Node 24.22.3 carry these files in `payload/runtime/notices/`. The complete upstream Node license remains in both runtime directories. `SHA256SUMS` records the included supplemental texts by path.

- `node-v24.22.3/` contains license files and copyright headers from the pinned Node source, including V8's bundled Abseil, fdlibm, FP16, Highway, rapidhash, SipHash, Strongtalk, UTF-8 decoder, TimSort and zlib materials. [Node.js source release](https://nodejs.org/dist/v24.22.3/node-v24.22.3.tar.xz)
- `chromium/` contains the BSD license referenced by Chromium's zlib headers. The V8 dependency pin identifies the zlib subrepository and its recorded Chromium source revision. [V8 dependency pins](https://github.com/nodejs/node/blob/v24.22.3/deps/v8/DEPS) · [Chromium license](https://chromium.googlesource.com/chromium/src/+/a8d5beb257203758bb904316344d220f19a20266/LICENSE)
- `hono/` preserves Hono's credit for the `Simplify` declaration shipped in its TypeScript definitions. `type-fest/` includes the MIT and CC0-1.0 alternatives from the matching release source. The precise source revision copied by Hono is unrecorded. [Hono source change](https://github.com/honojs/hono/pull/2581/files) · [Type-fest v4.18.0 license terms](https://github.com/sindresorhus/type-fest/blob/v4.18.0/package.json)
