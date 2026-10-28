# Setup and operation

Requires Python 3.10+ on Mac and Spark; Spark also needs an existing usable
Docker/Compose installation. Install `requirements.txt` into a dedicated venv.
Use the existing DeepSeek model service; deployment has no model/GPU mounts.

## Private configuration

Local `local-config.json` (ignored, never copied into a public package):

```json
{"python":"/absolute/path/to/python3", "remote_config":"/absolute/path/to/remote.json", "spool":"/absolute/path/to/research-results"}
```

The remote connection file contains `ssh_host`, `python`, `script`, `data_dir`.
Values identify the owner's authenticated Spark account and installed runtime.
SSH uses BatchMode and existing host-key/auth policy. Resolve any identity check
with the owner; don't disable it. Remote submission and collection pass bounded
JSON through the fixed CLI `rpc` endpoint, with shell-quoted trusted argv.

Spark private worker config:

```json
{"mode":"live", "model_base_url":"http://MODEL_HOST:PORT/v1", "model_id":"VERIFIED_MODEL_ID", "search_url":"http://127.0.0.1:8091/search", "engines":["duckduckgo","brave"], "defer_to_scout":true}
```

Optional `api_key_env` names a privately supplied environment variable. Keys are
never placed in manifests or request logs. First completion checks the server's
advertised model ID. No automatic provider fallback or frontier calls exist.

## Deploy on Spark

Copy scripts, requirements, deployment templates and references to a separate
owner directory. Preserve its data on upgrades. Create `.venv`, install pinned
requirements, and create a private worker config after verifying the model API.
Generate a random secret into a local copy of `settings.yml.example` named
`settings.yml`; keep both it and the private worker config mode 0600.

Use `docker compose -f deploy/compose.yaml up -d` after validating Compose,
ARM64 digest, available memory and unused port 8091. Inspect actual resource
limits and loopback listener. This runs only SearXNG; it doesn't touch the
distributed model containers. Disable/omit a failing upstream engine in both
settings and worker config; record it in verification. Don't force Startpage.

Run `research_gate.py capture --output pass-1.json`, then the same command at
least 30 minutes later for pass-2.json. `compare pass-1.json pass-2.json` checks
corpus, domain diversity, primary-source placement and spacing. It deliberately
does not certify relevance. Independently inspect relevant results for at least
eight queries per pass. `research_gate.py readers --output readers.json` saves
ten bounded source reads; at least eight must contain useful relevant text.

Render the user-unit template's `__ROOT__`, `__DATA__`, `__CONFIG__` with verified
absolute Spark paths, install as `~/.config/systemd/user/deep-research.service`,
reload user units and enable/start it only after the gate and fixture checks.
Confirm user lingering and service health. The watcher polls submitted jobs;
it does not invent new research. Scout deferral is best effort between calls,
and Mac coding clients may still share inference capacity.

## Submit and collect

Use `python scripts/research_cli.py prepare --brief QUESTION.txt
--submission-id UNIQUE_ID --output manifest.json`. `--scope` and `--limits`
accept JSON files. Inspect the normalized manifest/hash. User authorization
must cover that question, public-source scope, destination and limits; exact
already-authorized submissions need no repeated confirmation.

Run `python scripts/research_cli.py --remote-config REMOTE.json submit
--manifest manifest.json --approve-hash HASH`. Use the same submission ID/hash
after ambiguous SSH outcomes; don't create duplicate jobs. `status`, `stop`,
`resume` and `collect --job ID --output SPOOL` use the same remote-config flag.
Collection verifies checksums and approval identity before marking local
delivery. Full raw source bytes stay on Spark; extracted source text is in the
collected packet. Source artifacts aren't deleted or remotely acknowledged.

Stop is cooperative: the current bounded request may return before dispatch
ends. Resume preserves spent requests and the original deadline. A request
interrupted after reservation remains spent; a completed saved response is
reused. Completed/partial reports are terminal; extra budget requires a newly
authorized job. Defaults are 7200 seconds, 30 searches, 50 downloads and 20
model attempts, including draft, self-check and optional repair.

## Offline fixtures and validation

Prepare a manifest with `--mode fixture`, and use worker config
`{"mode":"fixture","fixture_file":"/absolute/path/fixture.json"}`.
The fixture file has `source_url` and `text` (at least 20 characters), optionally
a structured `report`. Run the CLI worker locally without `--watch`. Outputs
are labelled FIXTURE, and approval binds fixture/live mode. A live worker
blocks fixture manifests. Fixtures never prove actual search/model quality.

For isolated local testing, pass `--data-dir` before each subcommand, for example:

```sh
python scripts/research_cli.py --data-dir /tmp/research-fixture worker --config fixture-config.json
```

Use the same explicit data directory for local submit/status/collect operations.

Run `python -m unittest discover -s test/research -v` and `npm test` from the
source checkout, then the official skill validator and an independent forward
test. Before claiming live readiness also record the search gate, a real report
with five independently inspected claims, and Spark completion after the Mac
submission session disconnects. Self-checks and excerpt matching establish
provenance, not independent factual certification. PDF/OCR/headless browsing
are outside v1. Darwin parser memory bounds are weaker than Linux; Spark has a
hard process address-space limit plus service/container memory limits.
