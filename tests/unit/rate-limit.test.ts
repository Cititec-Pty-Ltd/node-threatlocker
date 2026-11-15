import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server.js';
import { RateLimitError } from '../../src/index.js';
import { HttpClient } from '../../src/http.js';
import { RateLimiter } from '../../src/rate-limiter.js';
import { RATE_LIMIT_RETRY, parseRetryAfter, retryDelayMs } from '../../src/rate-limit.js';

const BASE_URL = 'https://portalapi.g.threatlocker.com/portalapi';

const makeHttp = (maxRetries = 3) =>
  new HttpClient({ baseUrl: BASE_URL, apiKey: 'k', maxRetries, rateLimiter: new RateLimiter(1000) });

/** Answers each request with the next response in `responses` (the last one repeats). */
function sequence(responses: Array<() => Response>) {
  const state = { count: 0 };
  server.use(
    http.get(`${BASE_URL}/Thing`, () => {
      const next = responses[Math.min(state.count, responses.length - 1)]!;
      state.count++;
      return next();
    }),
  );
  return state;
}

const limited = (retryAfter?: string, status = 429) => () =>
  HttpResponse.json({ message: 'Too many requests' }, { status, headers: retryAfter ? { 'retry-after': retryAfter } : {} });
const ok = () => HttpResponse.json({ ok: true });

describe('parseRetryAfter', () => {
  it('reads delay-seconds, rounding fractions up', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('0.5')).toBe(500);
    expect(parseRetryAfter(' 0 ')).toBe(0);
  });

  it('reads an HTTP date relative to now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:07 GMT', now)).toBe(7000);
    expect(parseRetryAfter('Wed, 31 Dec 2025 23:59:00 GMT', now)).toBe(0);
  });

  it('ignores missing or invalid values', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter('-3')).toBeUndefined();
  });
});

describe('retryDelayMs', () => {
  it('uses Retry-After when given', () => {
    expect(retryDelayMs(0, 3000, 0)).toBe(3000);
  });

  it('backs off exponentially without Retry-After', () => {
    expect(retryDelayMs(0, undefined, 0, () => 0)).toBe(1000);
    expect(retryDelayMs(1, undefined, 1000, () => 0)).toBe(2000);
  });

  it('stops after maxRetries', () => {
    expect(retryDelayMs(RATE_LIMIT_RETRY.maxRetries, 1000, 0)).toBeUndefined();
  });

  it('does not wait longer than maxWaitMs or past maxTotalWaitMs', () => {
    expect(retryDelayMs(0, RATE_LIMIT_RETRY.maxWaitMs + 1, 0)).toBeUndefined();
    expect(retryDelayMs(1, 5000, RATE_LIMIT_RETRY.maxTotalWaitMs - 4000)).toBeUndefined();
  });
});

describe('HTTP 429 retry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for Retry-After (no extra backoff) and returns the retried success', async () => {
    const state = sequence([limited('2'), ok]);

    const pending = makeHttp().request('/Thing');
    await vi.advanceTimersByTimeAsync(1999);
    expect(state.count).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({ ok: true });
    expect(state.count).toBe(2);
  });

  it('gives up after two retries and reports HTTP 429 with the last Retry-After', async () => {
    const state = sequence([limited('3')]);

    const pending = makeHttp(5).request('/Thing');
    const assertion = expect(pending).rejects.toThrow(
      'ThreatLocker rate-limited the request (HTTP 429) for /Thing. Try again in 3 s.',
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    expect(state.count).toBe(RATE_LIMIT_RETRY.maxRetries + 1);
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBe(3);
    expect((error as RateLimitError).statusCode).toBe(429);
  });

  it('does not wait for a Retry-After longer than 10 s', async () => {
    const state = sequence([limited('60')]);

    await expect(makeHttp().request('/Thing')).rejects.toThrow(/HTTP 429.*Try again in 60 s\./);
    expect(state.count).toBe(1);
  });

  it('backs off 1 s then 2 s without Retry-After, then reports 60 s', async () => {
    const state = sequence([limited()]);

    const pending = makeHttp().request('/Thing');
    const assertion = expect(pending).rejects.toThrow(/HTTP 429.*Try again in 60 s\./);
    await vi.advanceTimersByTimeAsync(999);
    expect(state.count).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(state.count).toBe(3);
  });

  it('never retries more than maxRetries allows', async () => {
    const state = sequence([limited('1')]);

    const pending = makeHttp(1).request('/Thing');
    const assertion = expect(pending).rejects.toBeInstanceOf(RateLimitError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(state.count).toBe(2);
  });
});
