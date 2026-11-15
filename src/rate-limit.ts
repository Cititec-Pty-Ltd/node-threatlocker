/**
 * Bounded retry for rate-limited (HTTP 429) ThreatLocker responses.
 *
 * A short wait is retried so a brief burst does not surface as an error. A
 * long one is returned at once as a RateLimitError, so a call is never held
 * for minutes: the caller gets the Retry-After instead.
 */
export const RATE_LIMIT_RETRY = {
  /** Retries after the first attempt. */
  maxRetries: 2,
  /** Longest single wait. A larger Retry-After is not waited for. */
  maxWaitMs: 10_000,
  /** Longest total wait across the retries of one request. */
  maxTotalWaitMs: 20_000,
  /** Backoff for the first retry when the response has no Retry-After; doubles each retry. */
  baseBackoffMs: 1_000,
};

/** Parses a Retry-After value into milliseconds from `now`; undefined if absent or invalid. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed) * 1000);
  // Otherwise it must be an HTTP date ("Wed, 21 Oct 2015 07:28:00 GMT").
  if (!/[a-z]/i.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** Whole seconds from a response's Retry-After header (at least 1), or undefined. */
export function retryAfterSecondsOf(res: Response): number | undefined {
  const ms = parseRetryAfter(res.headers.get('retry-after'));
  return ms === undefined ? undefined : Math.max(1, Math.ceil(ms / 1000));
}

/**
 * Milliseconds to wait before retry number `attempt` (0-based), or
 * undefined when the request should not be retried.
 */
export function retryDelayMs(
  attempt: number,
  retryAfterMs: number | undefined,
  waitedMs: number,
  random: () => number = Math.random
): number | undefined {
  if (attempt >= RATE_LIMIT_RETRY.maxRetries) return undefined;
  const delay = retryAfterMs ?? RATE_LIMIT_RETRY.baseBackoffMs * 2 ** attempt + Math.floor(random() * 250);
  if (delay > RATE_LIMIT_RETRY.maxWaitMs) return undefined;
  if (waitedMs + delay > RATE_LIMIT_RETRY.maxTotalWaitMs) return undefined;
  return delay;
}

