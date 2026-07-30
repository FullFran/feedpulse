import type { DomainRateLimiterOptions } from '../src/modules/ingestion/infrastructure/domain-rate-limiter';
import { DomainRateLimiter } from '../src/modules/ingestion/infrastructure/domain-rate-limiter';

/**
 * Pure unit coverage for the component that stops this project from behaving
 * like a distributed hammer against other people's servers.
 *
 * Everything here is deterministic: `waitForSlot` genuinely sleeps, so every
 * test that reaches it runs under fake timers and drives the clock forward
 * explicitly instead of adding real seconds to the suite.
 */

const URL_A = 'https://alpha.example.com/rss.xml';
const URL_A_OTHER_PATH = 'https://alpha.example.com/atom.xml';
const URL_B = 'https://beta.example.com/rss.xml';

function createLimiter(options: DomainRateLimiterOptions = {}) {
  const metricsService = { incrementRateLimitBackoff: jest.fn() };
  const limiter = new DomainRateLimiter(metricsService as never, options);
  return { limiter, metricsService };
}

describe('DomainRateLimiter.parseRetryAfter', () => {
  it('returns the raw seconds string for a numeric Retry-After', () => {
    expect(DomainRateLimiter.parseRetryAfter('120')).toBe('120');
  });

  it('trims and lowercases before deciding, so a padded numeric header still parses', () => {
    expect(DomainRateLimiter.parseRetryAfter('  60  ')).toBe('60');
  });

  it('passes an HTTP-date through untouched so applyBackoff can re-parse it as a date', () => {
    const header = 'Wed, 21 Oct 2026 07:28:00 GMT';

    // The contract is deliberately awkward: parseRetryAfter returns a *string*
    // that applyBackoff parses again. The original casing must survive, because
    // `new Date(...)` is what consumes it.
    expect(DomainRateLimiter.parseRetryAfter(header)).toBe(header);
  });

  it('recognises an HTTP-date by comma, "gmt" or "utc" markers', () => {
    expect(DomainRateLimiter.parseRetryAfter('Wed 21 Oct 2026 07:28:00 UTC')).toBe('Wed 21 Oct 2026 07:28:00 UTC');
    expect(DomainRateLimiter.parseRetryAfter('21 Oct 2026 07:28:00 gmt')).toBe('21 Oct 2026 07:28:00 gmt');
  });

  it('returns null for a missing, empty or unrecognisable header', () => {
    expect(DomainRateLimiter.parseRetryAfter(null)).toBeNull();
    expect(DomainRateLimiter.parseRetryAfter('')).toBeNull();
    expect(DomainRateLimiter.parseRetryAfter('soon')).toBeNull();
    expect(DomainRateLimiter.parseRetryAfter('12.5')).toBeNull();
  });
});

describe('DomainRateLimiter.applyBackoff', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('honours a numeric Retry-After verbatim and reports the backoff as a metric', () => {
    const { limiter, metricsService } = createLimiter();

    limiter.applyBackoff(URL_A, '30', false);

    expect(limiter.isBackingOff(URL_A)).toBe(true);
    expect(limiter.getBackoffRemainingMs(URL_A)).toBe(30_000);
    expect(metricsService.incrementRateLimitBackoff).toHaveBeenCalledTimes(1);
  });

  it('converts a future HTTP-date Retry-After into the remaining milliseconds', () => {
    const { limiter } = createLimiter();
    const future = new Date(Date.now() + 45_000).toUTCString();

    limiter.applyBackoff(URL_A, future, false);

    // toUTCString() drops sub-second precision, so allow a one-second window.
    expect(limiter.getBackoffRemainingMs(URL_A)).toBeGreaterThan(44_000);
    expect(limiter.getBackoffRemainingMs(URL_A)).toBeLessThanOrEqual(45_000);
  });

  it('treats an HTTP-date already in the past as no backoff at all', () => {
    const { limiter, metricsService } = createLimiter();
    const past = new Date(Date.now() - 60_000).toUTCString();

    limiter.applyBackoff(URL_A, past, false);

    expect(limiter.isBackingOff(URL_A)).toBe(false);
    expect(metricsService.incrementRateLimitBackoff).not.toHaveBeenCalled();
  });

  it('does nothing when there is no Retry-After and this is not a retry', () => {
    const { limiter, metricsService } = createLimiter();

    limiter.applyBackoff(URL_A, null, false);

    expect(limiter.isBackingOff(URL_A)).toBe(false);
    expect(limiter.getBackoffRemainingMs(URL_A)).toBe(0);
    expect(metricsService.incrementRateLimitBackoff).not.toHaveBeenCalled();
  });

  it('starts a retry without Retry-After at the configured base delay', () => {
    const { limiter, metricsService } = createLimiter({ baseBackoffMs: 1_000, maxBackoffMs: 60_000 });

    limiter.applyBackoff(URL_A, null, true);

    expect(limiter.getBackoffRemainingMs(URL_A)).toBe(1_000);
    expect(metricsService.incrementRateLimitBackoff).toHaveBeenCalledTimes(1);
  });

  it('doubles from the previous deadline on each further retry', () => {
    const { limiter } = createLimiter({ baseBackoffMs: 1_000, maxBackoffMs: 60_000 });

    limiter.applyBackoff(URL_A, null, true);
    expect(limiter.getBackoffRemainingMs(URL_A)).toBe(1_000);

    limiter.applyBackoff(URL_A, null, true);
    expect(limiter.getBackoffRemainingMs(URL_A)).toBe(2_000);

    limiter.applyBackoff(URL_A, null, true);
    expect(limiter.getBackoffRemainingMs(URL_A)).toBe(4_000);
  });

  it('clamps exponential growth to maxBackoffMs', () => {
    const { limiter } = createLimiter({ baseBackoffMs: 1_000, maxBackoffMs: 5_000 });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      limiter.applyBackoff(URL_A, null, true);
    }

    expect(limiter.getBackoffRemainingMs(URL_A)).toBe(5_000);
  });

  it('doubles the time still remaining, not the original delay, when the clock has moved on', () => {
    const { limiter } = createLimiter({ baseBackoffMs: 1_000, maxBackoffMs: 60_000 });

    limiter.applyBackoff(URL_A, '10', false);
    expect(limiter.getBackoffRemainingMs(URL_A)).toBe(10_000);

    jest.advanceTimersByTime(6_000);
    limiter.applyBackoff(URL_A, null, true);

    // 4s were left of the previous deadline, so the next one is 8s, not 20s.
    expect(limiter.getBackoffRemainingMs(URL_A)).toBe(8_000);
  });

  it('keys backoff by hostname, so sibling paths share it and other domains do not', () => {
    const { limiter } = createLimiter();

    limiter.applyBackoff(URL_A, '30', false);

    expect(limiter.isBackingOff(URL_A_OTHER_PATH)).toBe(true);
    expect(limiter.isBackingOff(URL_B)).toBe(false);
    expect(limiter.getBackoffRemainingMs(URL_B)).toBe(0);
  });

  it('falls back to the whole string as the key when the URL cannot be parsed', () => {
    const { limiter } = createLimiter();

    limiter.applyBackoff('not a url', '30', false);

    expect(limiter.isBackingOff('not a url')).toBe(true);
    expect(limiter.isBackingOff('another unparseable value')).toBe(false);
  });

  it('tolerates a null metrics service instead of crashing the fetch path', () => {
    const limiter = new DomainRateLimiter(null as never);

    expect(() => limiter.applyBackoff(URL_A, '30', false)).not.toThrow();
    expect(limiter.isBackingOff(URL_A)).toBe(true);
  });
});

describe('DomainRateLimiter.clearBackoff', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('drops the deadline for the domain only', () => {
    const { limiter } = createLimiter();
    limiter.applyBackoff(URL_A, '30', false);
    limiter.applyBackoff(URL_B, '30', false);

    // HttpFeedFetcher calls this when the request is aborted by our own timeout:
    // the remote server never rate limited us, so the penalty must not stick.
    limiter.clearBackoff(URL_A_OTHER_PATH);

    expect(limiter.isBackingOff(URL_A)).toBe(false);
    expect(limiter.isBackingOff(URL_B)).toBe(true);
  });

  it('is a no-op for a domain that was never backed off', () => {
    const { limiter } = createLimiter();

    expect(() => limiter.clearBackoff(URL_A)).not.toThrow();
    expect(limiter.isBackingOff(URL_A)).toBe(false);
  });
});

describe('DomainRateLimiter.waitForSlot', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not wait for the first request to a domain', async () => {
    const { limiter } = createLimiter({ requestsPerSecond: 2 });

    await expect(limiter.waitForSlot(URL_A)).resolves.toBe(0);
  });

  it('spaces consecutive requests to the same domain by 1/requestsPerSecond', async () => {
    const { limiter } = createLimiter({ requestsPerSecond: 2 });
    await limiter.waitForSlot(URL_A);

    const pending = limiter.waitForSlot(URL_A);
    await jest.advanceTimersByTimeAsync(500);

    await expect(pending).resolves.toBe(500);
  });

  it('does not make one domain wait because another one was just fetched', async () => {
    const { limiter } = createLimiter({ requestsPerSecond: 2 });
    await limiter.waitForSlot(URL_A);

    await expect(limiter.waitForSlot(URL_B)).resolves.toBe(0);
  });

  it('waits out an active backoff before the per-domain spacing', async () => {
    const { limiter } = createLimiter({ requestsPerSecond: 2 });
    limiter.applyBackoff(URL_A, '2', false);

    const pending = limiter.waitForSlot(URL_A);
    await jest.advanceTimersByTimeAsync(2_000);

    await expect(pending).resolves.toBe(2_000);
    expect(limiter.isBackingOff(URL_A)).toBe(false);
  });
});
