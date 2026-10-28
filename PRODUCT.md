# Frontier Orchestrator

## Platform

Local web interface and a Mac coordinator, with an existing distributed local
DeepSeek service. The Codex conversation remains the primary supervision surface.

## Confirmed purpose and users

The owner approves an outcome, scope, mode and budget once. A durable coordinator
assigns bounded work, preserves evidence and spending, and exposes decisions that
need attention. Useful tested results matter more than model utilization.

The optional harness supports collaborative, DeepSeek-only, Codex-only and legacy
overnight-review presets. Existing authored workflows keep their original roles.
The public contract is [docs/HARNESS.md](docs/HARNESS.md); earlier workflow context
is in [docs/PRODUCT_CONTEXT.md](docs/PRODUCT_CONTEXT.md).

## Confirmed constraints

The local model service and its runtime are external dependencies. No model
configuration changes, public hosting, publication or unrestricted self-modification
are part of this build. Automatic adaptation is limited to managed memory and
protected, evaluated procedures. Private configuration stays outside tracked files.

The dashboard must expose actual backend state, distinguish fixtures from live
work, support keyboard access and reduced motion, and fit desktop and mobile web.
The owner selected the existing dark Carbon/Nunito visual system.

## Verification status

The harness is under implementation. Local fixtures and API smoke evidence do not
establish completion of the live pilots, independent deployment or Spark research
gates. Consult the implementation ledger and verification receipt for measured state.
