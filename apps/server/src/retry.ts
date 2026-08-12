/**
 * Shared retry/backoff for outbound requests: to the AI provider, to a
 * search engine, to anything else this server calls over the network.
 *
 * Before this existed, a transient network blip, a `5xx`, or a `429` rate
 * limit was treated exactly like a permanent failure (a bad key, a
 * malformed request) — the caller saw an error immediately, with no attempt
 * to wait the problem out. That is wrong in both directions: a rate limit
 * is often gone a second later, so failing instantly wastes a turn the
 * person was waiting on; and retrying a `401` is pointless, so a
 * non-retryable failure still has to surface as fast as it did before.
 *
 * `isRetryable` is the one place that draws the line, and everything else
 * here is generic — a plain `fetch` wrapper (`fetchWithRetry`) for the
 * request/response calls (models list, web search, embeddings), and
 * `withRetry` underneath it for anything that isn't shaped like a fetch.
 */

/** Capped at four extra tries — five attempts total — so a genuinely down
 * provider still fails in well under a minute rather than hanging. */
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    if (signal?.aborted) {
      rej(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      rej(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      res();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** An HTTP status worth retrying: rate-limited, or the provider's own fault — never ours. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Carries the HTTP status through a thrown error, so `isRetryable` can read it back. */
export class HttpStatusError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

/**
 * Whether `err` looks like the kind of failure a retry can plausibly fix —
 * a dropped connection or the provider asking to be tried again later, not
 * a request that was wrong from the start.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof HttpStatusError) return isRetryableStatus(err.status);
  // Node's `fetch` throws a `TypeError` for a connection that never
  // happened at all — DNS failure, connection refused, reset mid-request —
  // and only ever resolves normally (with whatever status) for anything
  // that made it to an HTTP response.
  if (err instanceof TypeError) return true;
  // The Anthropic SDK's own error classes carry `status` — `RateLimitError`
  // (429), `InternalServerError` (5xx) — and `APIConnectionError` carries
  // none, which is itself the signal: no status at all means the request
  // never reached the server.
  if (err && typeof err === 'object') {
    if ('status' in err && typeof (err as { status?: unknown }).status === 'number') {
      return isRetryableStatus((err as { status: number }).status);
    }
    if (err.constructor?.name === 'APIConnectionError') return true;
  }
  return false;
}

function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  return Number.isNaN(when) ? null : Math.max(0, when - Date.now());
}

/**
 * Retries `attempt()` on a retryable failure, waiting `Retry-After` when a
 * `HttpStatusError` carries one and falling back to exponential backoff
 * otherwise. Throws immediately, no wait, for anything `isRetryable` says
 * no to — a non-retryable failure gaining a delay would only make a clear
 * error slower to see.
 */
export async function withRetry<T>(
  attempt: () => Promise<T>,
  signal?: AbortSignal,
  retryAfter?: number | null,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (i >= RETRY_DELAYS_MS.length || !isRetryable(err) || signal?.aborted) throw err;
      await sleep(retryAfter ?? RETRY_DELAYS_MS[i], signal);
    }
  }
}

/**
 * `fetch`, but a retryable failure (a dropped connection, a `429`, a `5xx`)
 * is retried with backoff before the caller ever sees it. Resolves with the
 * `Response` exactly like `fetch` does — including a non-ok one, once
 * retries are exhausted or the status isn't retryable — so an existing
 * `if (!res.ok) …` at the call site keeps working unchanged; only a
 * network-level failure that never produced a `Response` at all is
 * re-thrown, and only once nothing is left to retry.
 */
export async function fetchWithRetry(url: string, init: RequestInit = {}): Promise<Response> {
  const signal = init.signal instanceof AbortSignal ? init.signal : undefined;
  for (let i = 0; ; i++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (i >= RETRY_DELAYS_MS.length || !isRetryable(err) || signal?.aborted) throw err;
      await sleep(RETRY_DELAYS_MS[i], signal);
      continue;
    }
    if (isRetryableStatus(res.status) && i < RETRY_DELAYS_MS.length && !signal?.aborted) {
      await sleep(retryAfterMs(res.headers.get('retry-after')) ?? RETRY_DELAYS_MS[i], signal);
      continue;
    }
    return res;
  }
}
