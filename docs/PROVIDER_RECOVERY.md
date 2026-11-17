# Bounded provider recovery

Mosaic uses the original approved provider, model, request budget and reconnect
window when recovering from a known safe failure. A failed request remains spent.
Recovery does not select a different model or extend an approval or deadline.

An explicitly declared **manual** model does not require a `/models` endpoint.
Its availability gate validates the configured identity and permits the next
already authorized attempt without sending a GET or POST. This is retry
eligibility, not evidence of reachability, provider health or model quality. The
completion still checks the original binding, controls, capacity and reservation
immediately before its single POST. Advertised models retain their exact model
membership checks; legacy discovery behavior is preserved.

Routed admission records manual eligibility separately from an observed
availability probe. Its saved route explanation explicitly says no network,
discovery or health probe occurred. This internal eligibility observation is
accepted only for the matching explicitly manual profile; advertised or
mismatched identities cannot use it.

For an otherwise retryable known safe failure, Mosaic accepts a single
`Retry-After` header of at most 128 UTF-8 bytes. Supported values are unsigned
integer seconds and strict IMF-fixdate dates, such as
`Tue, 17 Nov 2026 10:01:00 GMT`. Invalid values, duplicate native headers,
combined Fetch values and unsupported header representations are ignored. Only a
validated delay is carried forward; raw header values and provider error bodies
are not stored as retry metadata. JSON, injected Fetch and SSE HTTP errors use
the same bounded metadata contract.

The existing 15-second interval is a floor. Zero, short or past hints cannot
shorten it. Longer hints delay the next eligible probe or attempt within the
original window. A hint leaving no eligible retry before that window closes
blocks recovery immediately and explains that no eligible retry remains; it does
not claim that time has already elapsed. Saved absolute retry times survive a
restart. Older saved waits without retry hints retain their existing times.

After the existing completion rules establish a known safe failure, HTTP 401/403
and the allowlisted `context_length_exceeded` code are terminal, including a 429
with that code. These failures also terminate advertised availability probes.
Controls, deadlines, binding checks and settlement fences retain precedence.
An ordinary known safe 429 can still recover within the original window.

An ambiguous submitted inference remains uncertain even when the same terminal
metadata or a retry hint is attached. Its reservation, spending and ownership
hold remain intact. A hint is scheduling metadata, never proof of non-dispatch.
Existing disconnect, timeout, truncation and server-error classification remains
unchanged. Optional error-code inspection keeps its 4 KiB / 100 ms limits; SSE
wire, result and capture limits are unchanged.

The focused regression evidence uses scripted loopback responses, fake
coordinator time and disposable stores. It does not qualify an actual provider,
host authentication, native execution or real owner workflow. Full live recovery
and release qualification remain separate.
