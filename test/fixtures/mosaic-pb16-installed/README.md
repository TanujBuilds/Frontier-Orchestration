# Installed offline composition

`run.mjs` is copied outside the checkout and executed by the extracted archive's
ordinary bundled Node. It imports only Node built-ins and the installed MCP SDK.
It starts the installed beta service and stdio bridge; task, review, control and
integration mutations use public MCP tools. Read-only SQLite inspection locates
durable restart and supervisor-loss boundaries; it does not edit state.

`build-demo-input.mjs` explicitly materializes the sample project's pinned
Playwright 1.64.1 and accepted Chromium headless-shell 1248/ffmpeg 1013 bytes in a
separate inventoried archive. It requires named input directories and retains
upstream license files. It never reads a default user cache. This companion is
an offline test-project dependency input, not a Mosaic runtime dependency or a
downloadable product archive. The sample is adapted from the accepted stage 15
CSV fixture. Its protected `checks/download.mjs` stays byte-identical.

Inference and review replies are scripted on loopback. Node, SDK, service,
SQLite state, protected checks, Darwin sandbox/kernel probes, Chromium download,
Git integration and restart are real. No real host account/model is certified.

Run only after packaging/setup integration, with explicit artifacts:

```sh
MOSAIC_REQUIRE_INSTALLED=1 \
MOSAIC_INSTALLED_ARCHIVE=/absolute/local-release.tar.gz \
MOSAIC_INSTALLED_UPDATE_ARCHIVE=/absolute/next-compatible-version.tar.gz \
MOSAIC_INSTALLED_DEMO_ARCHIVE=/absolute/offline-project-inputs.tar.gz \
MOSAIC_INSTALLED_ROOT_PARENT=/absolute/owned-durable-fixtures \
MOSAIC_INSTALLED_EVIDENCE_DIR=/absolute/owned-evidence \
node --test --test-concurrency=1 test/mosaic-pb16-installed.test.mjs
```

Required mode fails on missing actual native/browser/artifact prerequisites;
ordinary source-only runs skip the two explicitly installed cases when no
artifacts were supplied. A skip is not installed acceptance.

The deliberate supervisor-loss case retains its actual original installation,
SQLite and receipt paths even after a passing run. Its bounded child is cleaned
up independently; the product owner remains uncertain. The wrapper copies a
consistent stopped SQLite/receipt inventory into the evidence directory. Do
not remove the retained fixture or treat liveness/timeout as a product receipt.
