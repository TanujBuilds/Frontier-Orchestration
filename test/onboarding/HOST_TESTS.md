# Onboarding forward-test handoff

These are evaluation scenarios, **not passing host evidence**. `scenarios.json`
is an evaluator-only matrix authored before the skill changes. It specifies
observable decisions, mode IDs and dispatch boundaries. Do not paste expected
answers into the host under test or count a substring match as compliance.

The supervisor owns the release's maximum two fresh native host test sessions
and ten-minute limit per session. Lane A launches none. Reuse those authorized
sessions; this fixture grants no extra session, coordinator, model or live work
budget. Keep prompts small and do not feed historical logs.

For session 1, use the actual installed skill/instruction loading mechanism in a
fresh Codex host, not an injected copy of expected guidance. Submit an undecided
substantial build request from the matrix; observe whether a four-choice question
appears and whether work is held. Reply with the selected mode and concrete
fixture-only scope/limits already authorized by the supervisor. Continue with an
in-scope follow-up and a quick definition question in the same session. Inspect
actual messages and tool arguments for no repeated selection, correct mode,
scoped preparation and no unauthorized activation/dispatch. If an active fixture
goal is used, preserve its actual ID/state for the follow-up; never fake tool
results or suggest an active goal exists when it does not.

Session 2 can cover an explicit mode and the installed MCP workflow under the
supervisor's single coding pilot. An explicit choice must bypass the mode
question but still obey exact scope/budget approval. Observe available tools and
actual preparation/activation boundaries. It is not a second pilot or fallback.
Additional matrix rows can be assessed in the same permitted sessions only
within their limits; otherwise mark them pending. Never mutate a real active
goal to test an unsupported transition, corrupt a real preference, or force an
endpoint outage. Use truthful fixture context or leave those rows pending.

Record per observed case: host/session identity, start/end time, installed
package hash, loaded instruction/skill evidence, prompt and follow-up transcript,
actual tool calls/results, selected mode, dispatch/activation evidence, exposed
usage (unknown if unavailable), verdict and limitations. For an adverse action,
record the exact first unexpected call or response. A model's promise to obey
later is not proof of dispatch protection. Static package/link validation and
backend regression tests do not prove native discovery or conversational routing.

A no-guidance control and repeated wording samples would improve skill-authoring
confidence, but must fit the supervisor's existing native-host budget. They have
not run in lane A. Do not claim the matrix is a red/green behavioral result or
that installation makes every desktop/ChatGPT conversation load these rules.
