# Portable API worker pools

Stage 11 adds an explicit provider pool for newly prepared coding goals. Existing
single-worker goals retain their saved manifests, approval hashes and replay
identities. Execution remains sequential. These interfaces are fixture-tested;
provider names or endpoint shapes are not evidence of live vendor compatibility.

## Configure and approve a pool

`src/harness/providers/contracts.mjs` exports `normalizeProfile`,
`profileIdentity`, `normalizeProviderPolicy` and the explicit
`normalizeLegacyWorkerProfile` adapter. `src/harness/providers/registry.mjs`
exports `ProviderRegistry`. The registry retains private credential references;
its `get(id, revision)` and `snapshot([{id, revision}])` methods return detached,
credential-free public identities. `profileIdentity(profile)` returns that
canonical identity object; `digest(profileIdentity(profile))` is its profile hash.

A private profile uses schema 1. Workers currently require `openai-chat`, the
`mosaic-structured-v1` worker protocol, and `coding` or `consult` task kinds.
Unsupported worker transports reject during normalization. There may be 1–16
approved workers. Each profile has a configured capacity group and declared
concurrency 1–4, while this stage accepts only `maxConcurrentTasks:1`.

This example uses a loopback fixture address and a caller-owned credential
resolver. The resolver runs at request time; resolve credentials from private
storage rather than adding bearer values to profile fields.

```js
import {Coordinator} from '../src/harness/coordinator.mjs';
import {ProviderRegistry} from '../src/harness/providers/registry.mjs';

const providerRegistry = new ProviderRegistry({
  profiles: [{
    schema: 1,
    id: 'local-worker', revision: 'r1', displayName: 'Local worker',
    transport: 'openai-chat',
    baseUrl: 'http://127.0.0.1:8080/v1', model: 'fixture-model',
    roles: ['worker'],
    capabilities: {
      workerProtocol: 'mosaic-structured-v1', transports: ['json'],
      modelDiscovery: 'manual', taskKinds: ['coding', 'consult'],
    },
    maxContextTokens: null, maxOutputTokens: 4096,
    concurrency: 1, capacityGroup: 'local-service',
    credentialRef: 'local-worker-auth', streaming: false,
  }],
  credentialResolver: reference => privateCredentialStore.read(reference),
});
const c = new Coordinator({root: '/tmp/disposable-mosaic-pool', providerRegistry});
const goal = c.prepareGoal({
  submissionId: 'pool-example', objective: 'Explain the approved worker binding',
  acceptance: ['Saved answer identifies the bound worker'],
  mode: 'deepseek_only', environment: 'fixture',
  providerPolicy: {
    version: 1,
    workers: providerRegistry.snapshot([{id: 'local-worker', revision: 'r1'}]),
    plannerWorkerId: 'local-worker', defaultWorkerId: 'local-worker',
    maxConcurrentTasks: 1, capacityGroups: [{id: 'local-service', limit: 1}],
  },
}, 'prepare-pool');
// Inspect goal.manifest and approve goal.hash through existing goal controls.
c.close();
```

`Coordinator({providerRegistry, workerProfile})` accepts the normalized catalog
alongside the historical `workerProfile` option. The options serve separate
approval paths: an explicit `providerPolicy` selects the pool; omission retains
the legacy path. The exported harness service also accepts
`serve({runtimeConfig: {providerRegistry, ...otherRuntimeOptions}, ...})` and
forwards the same catalog. JSON settings files cannot serialize a registry or
credential resolver. Interactive settings schema 2 and migration are stage 16
work; the existing private settings schema is unchanged here.

Public `goal_prepare`, `goal_revision_prepare` and `assignment_prepare` accept
`providerPolicy` through the dispatch input schema. The coordinator checks every
snapshot against the configured catalog. Public profiles reject credential
references, bearer fields and unknown keys. Prepared manifests add the canonical
`providerPolicy` and `providerPolicyHash`. Only worker-planned modes also add a
`plannerBinding`, selected by `plannerWorkerId`. Collaborative and codex_only
retain host planning. codex_only may omit or snapshot a pool; its assignments
remain host-owned and autonomous API dispatch remains prohibited.

## Durable assignment and request identity

`c.providerBinding(goal, providerId)` constructs this public binding:

```json
{"version":1,"providerId":"local-worker","revision":"r1","profileHash":"<sha256>","policyHash":"<sha256>"}
```

`c.verifyWorkerBinding(goal, taskOrBinding)` validates the entire approved pool
against the current catalog, then validates the supplied task or planner pin and
returns the selected public profile snapshot. Omitting the second argument
validates the pool and returns the default worker snapshot. Task validation also
checks its goal/version, autonomous actor and supported task kind. Legacy
no-policy verification keeps its prior behavior.

`submitTask` creates an autonomous task's `providerBinding` inside the existing
Store command transaction, using `defaultWorkerId`. Backlog, registered workflow
and recipe submission all enter that operation. Host tasks have no worker pin.
A submitted task retains the pin through claims, restart and retries; request
reservation copies it into the existing request receipt. Exact command replay
returns its saved result, and exact submission replay retains the original task
and binding. No additional binding ledger or read-time migration is created.

An exact portable `goal_prepare` retry with the original idempotency key returns
its saved preparation receipt even if the registry is unavailable or a configured
revision changed after restart. The saved command hash and public pool determine
that retry's identity; changed input or a key belonging to another operation
conflicts without writes. A different idempotency key is a fresh preparation
operation, including when it names the same submission. Fresh preparation and
activation still validate the current catalog, so replay grants no new authority
to run a stale profile. Historical no-policy preparation keeps its prior
normalization and replay behavior.

Before claim and model reservation the coordinator checks the current identities
of all pool members, including members other than the selected default. A changed
endpoint, model, capability, revision or missing catalog entry blocks progress
before new request spend. A cached request must carry the exact task binding.
Portable autonomous research and learning are unsupported because the worker
profile task kinds currently cover only coding and consult. Beta research stays
parked.

An explicit goal revision can approve a changed policy. An unstarted task can
then use the existing explicit rebind operation to adopt the new default pin.
Started tasks retain their full original binding, including the policy hash;
a changed pin is rejected. Rebinding retains existing limits, spending and
original task/goal deadlines. A policy change affecting another pool member also
changes the policy hash, so it cannot silently update a started assignment.

## Credentials and compatibility

Public identities include endpoint, transport, model, capabilities and capacity
fields. They exclude `credentialRef` and bearer values. Credential rotation may
preserve a profile identity, but the registry rejects rotation while a request
for that profile is in flight. Rotation never resets request spend or authorizes
replaying an uncertain result. Unknown request outcomes remain held for existing
recovery controls.

The schema 1 adapter is an explicit conversion of private configuration. It does
not rewrite saved goals or normalize historical worker objects into a different
shape. Legacy approval manifests, historical input schemas, capability snapshots
and command/submission replay hashes have literal baseline coverage in
`test/mosaic-pb11-bindings.test.mjs`.

This stage supplies immutable default bindings. Specialty routing, concurrent
runners and new reviewer transports are subsequent stages. Manual model
selection does not establish model availability; the existing reconnect probe
still requires a working model discovery endpoint. An endpoint without `/models`
may support an initial manual completion while remaining unable to satisfy that
reconnect probe.
