// Optional provider metadata only. Never retain the untrusted header value.
export function parseRetryAfter(value, nowMs) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 128 ||
      /[\x00-\x1f\x7f-\x9f]/u.test(value) || !Number.isSafeInteger(nowMs)) return null;
  if (/^[0-9]+$/.test(value)) {
    const milliseconds = BigInt(value) * 1000n;
    return milliseconds > BigInt(Number.MAX_SAFE_INTEGER)
      ? {kind: 'beyond_safe_time'} : {kind: 'delay', milliseconds: Number(milliseconds)};
  }
  // Date.parse alone also accepts obsolete dates and normalizes invalid days.
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(value)) return null;
  const at = Date.parse(value);
  if (!Number.isSafeInteger(at) || new Date(at).toUTCString() !== value) return null;
  const milliseconds = Math.max(0, at - nowMs);
  return Number.isSafeInteger(milliseconds) ? {kind: 'delay', milliseconds} : {kind: 'beyond_safe_time'};
}

export function normalizeRetryHint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const fields = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(fields);
    const kind = fields.kind?.value, milliseconds = fields.milliseconds?.value;
    if (kind === 'beyond_safe_time' && keys.length === 1) return {kind: 'beyond_safe_time'};
    if (kind === 'delay' && keys.length === 2 && keys.includes('milliseconds') &&
        Number.isSafeInteger(milliseconds) && milliseconds >= 0) return {kind: 'delay', milliseconds};
  } catch { /* Optional metadata cannot replace the original provider failure. */ }
  return null;
}

export function providedRetryHint(source) {
  try {
    // Custom Error/Fetch metadata must be an own data field. Never invoke an
    // accessor before preserving a known HTTP status or uncertain ownership.
    return normalizeRetryHint(Object.getOwnPropertyDescriptor(source, 'retryHint')?.value);
  } catch { return null; }
}

export function responseRetryHint(response, nowMs = Date.now()) {
  try {
  if (Array.isArray(response.rawHeaders)) {
    let value, count = 0;
    for (let i = 0; i < response.rawHeaders.length; i += 2) {
      if (typeof response.rawHeaders[i] === 'string' && response.rawHeaders[i].toLowerCase() === 'retry-after') {
        value = response.rawHeaders[i + 1]; count++;
      }
    }
    return count === 1 ? parseRetryAfter(value, nowMs) : null;
  }
  // Fetch Headers combines duplicates: combined deltas/dates fail the strict
  // parser. Other injected header representations cannot prove a single value.
  if (response.headers instanceof Headers) return parseRetryAfter(response.headers.get('retry-after'), nowMs);
  } catch { /* Unsupported optional headers cannot withhold a known status. */ }
  return null;
}

export function reconnectRetryAt(nowMs, until, value) {
  const hint = normalizeRetryHint(value);
  const delay = hint?.kind === 'beyond_safe_time' ? Infinity : Math.max(15000, hint?.milliseconds ?? 0);
  return delay >= until - nowMs ? until : nowMs + delay;
}

// Call only after existing non-dispatch certification, or for a GET probe.
export function terminalProviderFailure(error) {
  try {
    const status = Object.getOwnPropertyDescriptor(error, 'httpStatus')?.value;
    const code = Object.getOwnPropertyDescriptor(error, 'providerErrorCode')?.value;
    return status === 401 || status === 403 || code === 'context_length_exceeded';
  } catch { return false; }
}
