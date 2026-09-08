/** Retry only temporary read failures, preserving the exact bounded request. */
export async function readPage(request, path, options, { onRetry = () => {}, wait = pause } = {}) {
  for (let attempt = 0; ; ++attempt) {
    const response = await request(path, options);
    if (![429, 502, 503, 504].includes(response.status) || attempt >= 4) return response;
    const retryAfter = response.headers.get('Retry-After');
    const seconds = retryAfter == null ? 0 : /^\d+$/.test(retryAfter) ? Number(retryAfter) : (Date.parse(retryAfter) - Date.now()) / 1000;
    const delay = Math.max(1000 * 2 ** attempt, Number.isFinite(seconds) ? seconds * 1000 : 0);
    // Do not silently disregard a provider's longer waiting period.
    if (delay > 30000) return response;
    onRetry(attempt + 1, Math.ceil(delay / 1000));
    await wait(delay, options.signal);
  }
}
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
