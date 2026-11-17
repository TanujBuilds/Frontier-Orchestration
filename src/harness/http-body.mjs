const problem = (status, message) => Object.assign(Error(message), {status});

// Internal byte reader shared by login/invoke and deterministic fragment tests.
export async function readRequestBody(request, max = 1048576) {
  let size = 0, bytes, oversized = false;
  try {
    for await (const chunk of request) {
      if (oversized) continue;
      if (chunk.length > max - size) {
        oversized = true;
        bytes = undefined;
        // Drain without retaining input. The API's existing request deadline
        // still applies; exiting the iterator here would destroy the socket
        // before the caller can send its 413 response.
        continue;
      }
      if (chunk.length) {
        bytes ??= Buffer.allocUnsafe(max);
        bytes.set(chunk, size);
        size += chunk.length;
      }
    }
  } catch {
    throw problem(400, 'Incomplete request body');
  }
  if (oversized) throw problem(413, 'Request body exceeds limit');
  try {
    // Keep a leading BOM: JSON.parse must retain its previous rejection of it.
    return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true})
      .decode(bytes?.subarray(0, size));
  } catch {
    throw problem(400, 'Invalid UTF-8 request body');
  }
}
