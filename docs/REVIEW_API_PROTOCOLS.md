# Reviewer API protocols

Source/config fixtures, checked November 11, 2026. No live provider or billing verification is claimed. Reviewers use the configured API endpoint, model and private request-time credential resolver; coding-app credentials and subscriptions are separate. These transports expose no shell, file, browser, tool invocation or integration operation. ReviewService validates the returned verdict against the exact current ticket before acceptance.

| Profile transport | Request path under the configured base | Output contract | Evidence level |
|---|---|---|---|
| `openai-chat` | `chat/completions` | Nonstreaming Chat Completions JSON mode; local verdict validation | fixture-tested |
| `openai-responses` | `responses` | Nonstreaming Responses strict `text.format` JSON schema; local verdict validation | fixture-tested |
| `anthropic-messages` | `messages` | Nonstreaming direct Claude Messages, `anthropic-version: 2026-10-21`; JSON-only prompt and local verdict validation | fixture-tested |

All three accept credential-free profile identities already approved in `reviewPolicy`. `ProviderRegistry.createReviewer(binding)` checks exact configured revision/profile hash, reviewer role and JSON capability. Its frozen wrapper resolves the private credential only during `review`, shares credential-rotation fencing with worker clients and bounds credential lookup to five minutes or the caller's earlier cancellation. Generic worker JSON/SSE code remains separate.

Official documentation was opened and inspected, rather than inferred from SDK names:

- [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create): `messages`, `response_format`, `max_tokens`, `choices[].message`, finish reason and usage.
- [OpenAI Responses](https://developers.openai.com/api/reference/resources/responses/methods/create): `input`, `instructions`, `max_output_tokens`, `text.format`, completed output messages and usage. The adapter sets `store:false` and sends no tools.
- [Claude Create a Message](https://platform.claude.com/docs/en/api/http/messages/create): current `2026-10-21` request version, `system`, `messages`, `max_tokens`, content blocks, stop reason and usage.
- [Claude API versions](https://platform.claude.com/docs/en/api/versioning) and [authentication](https://platform.claude.com/docs/en/manage-claude/authentication): the pinned current version and `Authorization: Bearer` authentication. A single-workspace-scoped API credential is required by this adapter: the approved profile schema has no workspace header field, so a key requiring an explicit workspace header fails at the provider instead of acquiring an unapproved header/configuration extension. Legacy `x-api-key`, cloud-platform IAM, host-login tokens and SDK automatic retry are not used.
- [Claude errors](https://platform.claude.com/docs/en/api/errors?version=2026-10-21): HTTP status and nested error shape. Raw error bodies are intentionally not persisted or exposed, because they may repeat authentication values.
- [Claude thinking](https://platform.claude.com/docs/en/build-with-claude/thinking): models may return thinking by default. The adapter discards `thinking` and `redacted_thinking` blocks and validates only final text as a verdict; reasoning is not retained in results. Tools, refusals, truncation and responses without final verdict text still fail.

The Chat adapter sends `max_tokens`; models that require another token-limit field (including the documented o-series restriction) are not supported by that adapter. Select a compatible approved transport/model explicitly. A passing generic fixture is not evidence that every model alias supports that request format.

## Concrete fixture exchanges

These examples are independently authored protocol fixtures. IDs, names and token counts are synthetic; the tests assert native protocol fields and normalize different envelopes rather than echoing the request serializer. The base URL is an owned dynamic loopback server ending in `/v1`.

Chat request body (the actual system prompt is the bounded review instruction in `transports/common.mjs`):

```json
{"model":"requested-alias","stream":false,"max_tokens":123,"response_format":{"type":"json_object"},"messages":[{"role":"system","content":"Return one review verdict JSON object only."},{"role":"user","content":"{\"checks\":[{\"id\":\"unit\",\"passed\":true}]}"}]}
```

Chat response:

```json
{"id":"chatcmpl_fixture","object":"chat.completion","model":"alias-2026-10-01","choices":[{"index":0,"message":{"role":"assistant","content":"{\"decision\":\"accept\",\"feedback\":\"Scoped checks and diff reviewed.\",\"findings\":[]}","refusal":null},"finish_reason":"stop"}],"usage":{"prompt_tokens":53,"completion_tokens":18,"total_tokens":71}}
```

Responses request uses `max_output_tokens:123`, `input` containing evidence JSON, `instructions` containing the review instruction, `stream:false`, `store:false`, and `text.format:{type:"json_schema",name:"mosaic_review_verdict",strict:true,schema:...}`. The schema is committed in `transports/common.mjs`. Strict output requires every finding property to be required, so its wire `line` is an integer or null. Only this native protocol's `line:null` is translated to the common contract's omitted optional line.

Responses response:

```json
{"id":"resp_fixture","object":"response","status":"completed","error":null,"incomplete_details":null,"model":"alias-2026-10-02","output":[{"id":"rs_fixture","type":"reasoning","summary":[]},{"id":"msg_fixture","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"{\"decision\":\"accept\",\"feedback\":\"Scoped checks and diff reviewed.\",\"findings\":[]}","annotations":[]}]}],"usage":{"input_tokens":61,"output_tokens":25,"total_tokens":86}}
```

Messages request includes `anthropic-version:2026-10-21`, JSON content type and `Authorization:Bearer <private API credential>`. Body:

```json
{"model":"requested-alias","stream":false,"max_tokens":123,"system":"Return one review verdict JSON object only.","messages":[{"role":"user","content":"{\"checks\":[{\"id\":\"unit\",\"passed\":true}]}"}]}
```

Messages response:

```json
{"id":"msg_fixture","type":"message","role":"assistant","model":"alias-2026-10-03","content":[{"type":"text","text":"{\"decision\":\"accept\",\"feedback\":\"Scoped checks and diff reviewed.\",\"findings\":[]}"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":43,"output_tokens":21}}
```

Synthetic HTTP 401/429/500/529 bodies include both `{"error":{"message":"rate limit","type":"rate_limit_error"}}` and `{"type":"error","error":{"type":"overloaded_error","message":"try later"}}`. Tests also independently modify native refusal, truncation, tool-call, malformed JSON, reported alias and token fields. A valid JSON object containing a hostile extra command is still untrusted data: the shared verdict schema/service rejects extra fields; nothing in the adapter executes content.

## Accounting and failure semantics

`review({evidence,signal,maxOutputTokens})` returns `{content,usage:{inputTokens,outputTokens,totalTokens},requestedModel,reportedModel}`. Missing model/usage stays null. Anthropic total is the sum of reported input/output counts; it is not verified billing. Models reported behind a configured alias remain separately labeled. The request is one nonstreaming POST with manual redirect handling, a five-minute maximum transport deadline, at most 1 MiB evidence, 512 KiB wire response and 64 KiB JSON content. The requested output ceiling cannot exceed the approved profile. No model discovery probe or fallback endpoint runs.

Failures before fetch invocation carry `requestOutcome:not_dispatched`. HTTP refusal/error, complete but malformed/truncated output and size rejection carry `completed`; timeout/disconnect after fetch invocation carry `ambiguous`. A completed error does not mean zero spend. ReviewService persists its request reservation before calling the adapter, retains original spend/deadline and never blindly retries ambiguity. The adapter never retries any outcome. Credentials are redacted from outgoing evidence, returned JSON content/model and errors, including JSON-escaped echoes. Raw provider errors and response headers are not part of public results.

The service supplies a synchronous authority check immediately before the POST, after asynchronous credential lookup. A goal/task pause, stop, expiry or changed approval prevents a new dispatch even if credential resolution finishes later. Its reservation remains spent and is recorded as not dispatched; this does not undo a request already sent to the provider.

Run `node --test test/mosaic-pb12-api.test.mjs` for adapter fixtures, plus review/accounting tests for ticket reservation, replay, revocation and budget authority. Passing fixtures do not certify a particular installed provider/model, account, app, platform or public release.
