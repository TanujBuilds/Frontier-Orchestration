# Contributing to Mosaic

Mosaic is an experimental MIT source preview. A passing source check is useful evidence for a code change; actual host connections, live model work and a qualified Mac download need separate evidence. Read the [product context](docs/PRODUCT_CONTEXT.md) before changing coordinator, approval or execution behavior.

Use Node.js **24.22.0**, Git, Python 3 and a POSIX environment (Linux or macOS). From the repository root:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run test:source -- --list
npm test
npm run demo -- "Explain a small change"
```

The demo uses fake adapters and needs no model service, host login or API key. The portable tests use disposable repositories, injected adapters and owned loopback fixtures. They need no Playwright browser download. Development requirements differ from an installed Mac bundle, which includes its coordinator runtime and dependencies.

Keep changes focused and describe the behavior before and after the change. Add a regression that demonstrates a concrete bug or new behavior, run the affected entry files, then run `npm test`. Include the command, runtime, platform, result and any excluded or unverified gates in your review request. Never replace a strict required check with a skip or claim a fixture proves live model or host readiness.

Add test entries only as direct `test/*.test.mjs` or `test/project/*.test.mjs` files. Keep fixture drivers and helpers outside those entry names. If a new entry uses native execution, a browser, package building or installed archives, update the runner's classification and explain the separate qualification requirement. Never rely on bare `node --test` discovery.

Keep credentials, personal endpoints, local bindings, absolute user paths and raw private evidence out of commits and reports intended for publication. Model output does not authorize commands, file exposure or wider scope. Preserve exact approval hashes, budgets, provider identity and uncertain execution ownership when changing the coordinator.

See [development setup](docs/DEVELOPMENT.md) for layout and offline preparation, [test profiles](docs/TESTING.md) for selection and required inputs, and [release evidence](docs/PORTABLE_BETA_RELEASE.md) for qualification limits. The npm package intentionally remains `private: true`; that guard prevents npm publication and does not determine GitHub visibility.
