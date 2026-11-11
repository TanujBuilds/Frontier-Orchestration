# Explicit worker routing

Routing version 1 chooses a configured worker deterministically. It makes no
inference requests, health probes, filesystem writes, credential reads, or clock
reads. Task categories record owner preferences; they do not rank model brands
or grant access to images, tools, files, or networks.

For an approved pool containing dummy profiles `workerA` and `workerB`, a policy
may prefer the first for backend work and the second for frontend work:

```json
{
  "version": 1,
  "rules": [
    {"id": "backend-primary", "category": "backend", "providerId": "workerA"},
    {"id": "frontend-primary", "category": "frontend", "providerId": "workerB"}
  ],
  "defaultWorkerId": "workerA"
}
```

Rules remain in their supplied order. The first matching category rule wins,
including when several rules name the same category. Categories are `general`,
`backend`, `frontend`, `tests`, `docs`, and `design`. A policy has at most 32 rules,
unique rule IDs, and references only its approved pool of at most 16 workers.

An explicit task requirement can look like:

```json
{
  "version": 1,
  "category": "backend",
  "requiredCapabilities": [],
  "minContextTokens": 16000,
  "maxOutputTokens": 2048,
  "preferredProviderId": "workerB"
}
```

`preferredProviderId` is strict: this task chooses `workerB` before consulting
rules or the default. The selector then validates only that chosen worker. An
ineligible first choice blocks; a busy or offline first choice waits. Neither
case tries another rule or worker. There is no automatic fallback or quality
scoring. `requiredCapabilities` may add `coding` or `consult`; the actual
`task.kind` is always required even when that list is empty. Routing supports
only those two kinds. A design category does not enable image input.

Mode eligibility is also mandatory. The task must use the worker execution
actor and its approved pinned mode and task capability must permit that actor
and kind. Host tasks retain host execution, and a host-only mode cannot acquire
API-worker authority through routing. Coding-only overnight work cannot route
a consult task. Existing protocol aliases `deepseek` and `codex` identify the
worker and host execution channels respectively; they say nothing about the
configured provider's actual model or brand.

An unknown context ceiling cannot satisfy an explicit minimum. A configured
context ceiling equal to the minimum is sufficient. An explicit output
requirement cannot exceed the profile's configured output ceiling. Unknown
prices do not become zero costs, and routing estimates no prices.

## Pure interfaces

`normalizeRoutingPolicy(raw, providerPolicy)` and `normalizeTaskRouting(raw)`
return detached canonical JSON or throw. Unknown fields, invalid identifiers,
duplicate capabilities, unsupported versions, and unsafe token integers reject.
`undefined` returns `undefined`, preserving historical absent-field hashes.
Only an explicit `{version:1}` task routing object receives `category:'general'`,
`requiredCapabilities:[]`, `minContextTokens:null`, and `maxOutputTokens:null`.
The coordinator may create that new versioned object for newly prepared tasks
in a goal that opted into routing. Historical goals remain on their old path.

`selectRoute({task,goal,availability})` accepts a task spec or task record with
`spec`, and a goal manifest or goal record with `manifest`. A goal must supply
its canonical `providerPolicy` and matching `providerPolicyHash`. It must also
supply `routingPolicy`; `routingPolicyHash`, when supplied, must match. A missing
task routing field defaults only within that routing-enabled goal. Explicit
null, undefined, or malformed task routing metadata rejects.

`goal.mode` and `goal.capabilities` are trusted approved snapshots, and
`task.actor` must be explicit after normal task normalization. Mode validation
uses the same actors, planner, review, kinds, identifiers, and version bounds as
`Registry.registerMode`; an approved registered custom mode remains supported.
The matching pinned task capability must include its ID, positive version,
matching handler, and permitted actors. Missing or malformed authority metadata
is unknown eligibility and returns no binding. The selector does not infer
actor defaults or authenticate approval provenance itself: the coordinator
verifies the saved goal approval/hash and supplies those trusted snapshots.

Availability is a caller-supplied observation snapshot:

```js
{
  providers: [{
    providerId: 'workerA',
    revision: 'revision-1',
    profileHash: '<SHA-256 of the approved credential-free profile identity>',
    status: 'available', // available | busy | offline | unknown
    observedAt: '2026-11-11T20:00:00.000Z',
    provenance: 'bounded coordinator availability probe'
  }],
  budget: {remainingModelCalls: 5}
}
```

`providers` contains at most 16 observations. A usable selected observation
requires exactly one entry for the chosen ID, the approved revision/hash, a
valid UTC timestamp (seconds with optional three-digit milliseconds), and a
nonempty provenance string of at most 200 characters. Missing, malformed,
ambiguous, mismatched, or explicitly unknown observations yield
`availability_unknown`. Observations do not carry credentials or provider
response bodies. Provenance describes the measurement source, not model text.

The selector has no clock and imposes no observation freshness interval. It
reports precisely the supplied observation time and provenance. The caller
owns freshness: use a bounded probe for a current dispatch decision, or mark
old/unproven observations unknown. A previous successful request or persisted
`available` row alone is not present health proof. Read-only previews may
return `waiting` from absent observations; they need not manufacture health.

`remainingModelCalls` is the remaining original coordinator budget, including
spent/uncertain requests. It is a nonnegative safe integer, or unknown when
absent/null/invalid. Zero blocks before consulting endpoint availability.
Unknown remaining budget never authorizes a request. It must not be reset
on retry, a worker change, reconnect, or preview.

The return object always has exactly these fields:

```js
{
  status: 'selected', // selected | waiting | ineligible
  binding: {
    version: 1,
    providerId: 'workerA',
    revision: 'revision-1',
    profileHash: '<approved public profile hash>',
    policyHash: '<approved providerPolicy hash>'
  },
  reasonCode: 'selected_by_rule',
  explanation: 'Rule backend-primary for backend chose workerA. ...',
  matchedRule: {id:'backend-primary',category:'backend',providerId:'workerA'}
}
```

`matchedRule` is a detached rule object or null for explicit/default selection.
The explanation preserves the choice source even when eligibility fails or
availability requires waiting. `binding` is null on `ineligible`. `waiting`
retains the statically eligible binding so the caller can probe only that
selected provider without pretending it is healthy. It grants no reservation
or dispatch authority. Identical inputs produce identical output.

The coordinator persists the chosen binding atomically at claim under the
same approved goal version. Started tasks keep their original binding across
repair, restart, and configuration changes. It checks original permissions,
mode, pause/stop state, deadline, generation, identity, and budget again after
any awaited probe and immediately before POST. Selection does not perform
those state transitions or replace those guards. Worker-planned modes keep
their approved planner binding; host-planned modes keep host planning.

## Reason codes

| Code | Status | Meaning |
| --- | --- | --- |
| `selected_by_explicit` | selected | Strict explicit worker preference passed all supplied checks. |
| `selected_by_rule` | selected | First matching ordered category rule passed all supplied checks. |
| `selected_by_default` | selected | Routing default passed all supplied checks. |
| `routing_policy_missing` | ineligible | No routing policy; use the coordinator's historical path where applicable. |
| `provider_policy_invalid` | ineligible | Missing or invalid approved worker pool. |
| `provider_policy_changed` | ineligible | Pool differs from its approved hash. |
| `routing_policy_invalid` | ineligible | Policy version, fields, rules, or pool references are invalid. |
| `routing_policy_changed` | ineligible | Policy differs from its supplied approved hash. |
| `task_routing_invalid` | ineligible | Invalid task category or routing requirements. |
| `provider_not_approved` | ineligible | Explicit chosen worker is outside the approved pool. |
| `worker_role_unsupported` | ineligible | Selected profile cannot act as a supported worker. |
| `task_kind_unsupported` | ineligible | Actual task kind is outside coding/consult. |
| `mode_eligibility_unknown` | ineligible | Required pinned mode, actor, or task capability metadata is missing or malformed. |
| `mode_worker_prohibited` | ineligible | Pinned mode permits no API-worker execution. |
| `task_actor_prohibited` | ineligible | Task uses host execution rather than the permitted worker channel. |
| `mode_capability_prohibited` | ineligible | Pinned mode or task capability prohibits the actual worker kind/actor. |
| `capability_unsupported` | ineligible | Worker lacks the actual kind or an additional requirement. |
| `context_limit_unknown` | ineligible | Unknown context capacity cannot satisfy an explicit minimum. |
| `context_limit_insufficient` | ineligible | Known context capacity is below the minimum. |
| `output_limit_insufficient` | ineligible | Output requirement exceeds configured capacity. |
| `budget_exhausted` | ineligible | Original model-call budget has no remaining requests. |
| `availability_unknown` | waiting | No usable observation establishes selected availability. |
| `provider_busy` | waiting | Selected worker was busy according to the supplied observation. |
| `provider_offline` | waiting | Selected worker was offline according to the supplied observation. |
| `budget_unknown` | waiting | Remaining original request budget is unknown. |

The routing unit tests use dummy identities and supplied observations. They
demonstrate deterministic offline behavior; they do not certify live provider
compatibility or comparative model quality.
