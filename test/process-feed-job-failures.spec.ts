import { Logger } from '@nestjs/common';
import { ProcessFeedJobUseCase } from '../src/modules/ingestion/application/process-feed-job.use-case';
import { expectDefined } from './support/expect-defined';

/**
 * Failure classification for `ProcessFeedJobUseCase`.
 *
 * The whole tree is driven by SUBSTRING MATCHING on error message text
 * (`status 404`, `feed not recognized as rss`, `enotfound`, ...). That is the
 * most fragile coupling in the repository: a dependency upgrade that rewords
 * one of those messages silently turns a terminal failure into an infinite
 * retry loop, or auto-pauses a feed that was only briefly unreachable. These
 * tests pin every branch, both thresholds and the `shouldRethrow` decision that
 * determines whether BullMQ retries the job at all.
 *
 * Backoff values contain `Math.random()` jitter, so exact expectations are only
 * asserted with `Math.random` stubbed to 0; the unstubbed behaviour is asserted
 * as bounds.
 */

const HOUR_SECONDS = 60 * 60;
const DNS_AUTO_PAUSE_DELAY_SECONDS = 12 * HOUR_SECONDS;
const BLOCKED_AUTO_PAUSE_DELAY_SECONDS = 14 * HOUR_SECONDS;
const MAX_ERROR_BACKOFF_SECONDS = 6 * HOUR_SECONDS;

interface UpdateAfterFetchCall {
  feedId: number;
  status: 'active' | 'paused' | 'error';
  errorCount: number;
  lastError: string | null;
  nextCheckAt: string;
}

interface FetchLogCall {
  statusCode: number | null;
  error: boolean;
  errorMessage: string | null;
}

interface HarnessOptions {
  /** Error thrown by the fetcher, or an HTTP status the fetcher resolves with. */
  failure: { throws: string } | { statusCode: number };
  errorCount?: number;
  pollIntervalSeconds?: number;
}

function createHarness(options: HarnessOptions) {
  const updates: UpdateAfterFetchCall[] = [];
  const fetchLogs: FetchLogCall[] = [];
  let fetchErrorsIncremented = 0;

  const databaseService = {
    query: async (_sql: string, params: unknown[] = []) => {
      fetchLogs.push({
        statusCode: params[2] as number | null,
        error: params[4] as boolean,
        errorMessage: params[5] as string | null,
      });
      return { rows: [] as unknown[], rowCount: 0 };
    },
    getPool: () => ({
      connect: async () => ({
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => undefined,
      }),
    }),
  };

  const findFeed = async () => ({
    id: 7,
    tenantId: 'tenant_a',
    url: 'https://example.com/rss.xml',
    etag: null,
    lastModified: null,
    pollIntervalSeconds: options.pollIntervalSeconds ?? 300,
    errorCount: options.errorCount ?? 0,
  });

  const useCase = new ProcessFeedJobUseCase(
    { assertSchemaReady: async () => undefined } as never,
    databaseService as never,
    {
      // The worker resolves the feed by bare id; the tenant is only known once
      // the row is read. Both accessors are stubbed so the harness survives
      // either lookup name.
      findById: findFeed,
      findByIdForWorker: findFeed,
      updateAfterFetch: async (call: UpdateAfterFetchCall) => {
        updates.push(call);
      },
    } as never,
    { insertMany: async () => [] } as never,
    { listActive: async () => [] } as never,
    { createForEntryWithRules: async () => ({ created: [], ruleSetExtended: [] }) } as never,
    { execute: async () => undefined } as never,
    { fetchTimeoutMs: 1000 } as never,
    {
      observeFetchDuration: () => undefined,
      incrementEntriesInserted: () => undefined,
      incrementAlertsGenerated: () => undefined,
      incrementFetchErrors: () => {
        fetchErrorsIncremented += 1;
      },
    } as never,
    {
      fetch: async () => {
        if ('throws' in options.failure) {
          throw new Error(options.failure.throws);
        }

        return {
          statusCode: options.failure.statusCode,
          durationMs: 5,
          etag: null,
          lastModified: null,
          body: '',
        };
      },
    },
  );

  return {
    useCase,
    updates,
    fetchLogs,
    get fetchErrorsIncremented() {
      return fetchErrorsIncremented;
    },
  };
}

interface RunOutcome {
  update: UpdateAfterFetchCall;
  fetchLogs: FetchLogCall[];
  rethrown: Error | null;
  nextCheckInSeconds: number;
  fetchErrorsIncremented: number;
}

async function run(options: HarnessOptions): Promise<RunOutcome> {
  const harness = createHarness(options);
  const startedAt = Date.now();
  let rethrown: Error | null = null;

  try {
    await harness.useCase.execute({ feedId: 7 });
  } catch (error) {
    rethrown = error as Error;
  }

  const update = harness.updates[harness.updates.length - 1];
  expect(update).toBeDefined();

  return {
    update: expectDefined(update),
    fetchLogs: harness.fetchLogs,
    rethrown,
    nextCheckInSeconds: Math.round((Date.parse(expectDefined(update).nextCheckAt) - startedAt) / 1000),
    fetchErrorsIncremented: harness.fetchErrorsIncremented,
  };
}

describe('ProcessFeedJobUseCase failure classification', () => {
  beforeEach(() => {
    // Jitter off by default: every "exact seconds" expectation below is the
    // un-jittered base. The jitter itself is asserted separately, as bounds.
    jest.spyOn(Math, 'random').mockReturnValue(0);
    // Every auto-pause logs a warning; keep the suite output readable.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('terminal categories (feed is paused, job is not retried)', () => {
    const terminalCases: Array<{ name: string; options: HarnessOptions }> = [
      { name: 'HTTP 404', options: { failure: { statusCode: 404 } } },
      { name: 'HTTP 410 Gone', options: { failure: { statusCode: 410 } } },
      { name: 'a document that is not a feed', options: { failure: { throws: 'Feed not recognized as RSS or Atom' } } },
      { name: 'an SSRF-rejected host', options: { failure: { throws: 'unsafe_host' } } },
      { name: 'a non-http(s) scheme', options: { failure: { throws: 'unsafe_protocol' } } },
      { name: 'a host outside the allow list', options: { failure: { throws: 'feed_url_host_not_allowed' } } },
      { name: 'an oversized body', options: { failure: { throws: 'feed_body_too_large' } } },
      { name: 'XML that cannot be parsed', options: { failure: { throws: 'Unable to parse XML' } } },
      { name: 'an invalid XML character', options: { failure: { throws: 'Invalid character in entity name' } } },
      { name: 'an attribute without value', options: { failure: { throws: 'Attribute without value' } } },
    ];

    it.each(terminalCases)('pauses the feed and swallows the job error for $name', async ({ options }) => {
      const outcome = await run(options);

      expect(outcome.update.status).toBe('paused');
      expect(outcome.rethrown).toBeNull();
      // Terminal failures keep the raw message: only auto-pauses get the prefix.
      expect(outcome.update.lastError).not.toContain('auto-paused:');
    });

    it('still increments the error counter and records a failed fetch log', async () => {
      const outcome = await run({ failure: { statusCode: 404 }, errorCount: 2 });

      expect(outcome.update.errorCount).toBe(3);
      expect(outcome.fetchErrorsIncremented).toBe(1);
      expect(outcome.fetchLogs).toEqual([
        { statusCode: null, error: true, errorMessage: 'Feed fetch failed with status 404' },
      ]);
    });

    it('uses the ordinary exponential backoff, not the auto-pause delay', async () => {
      const outcome = await run({ failure: { statusCode: 404 }, errorCount: 0, pollIntervalSeconds: 300 });

      // errorCount 1 => 300 * 2^0 = 300s.
      expect(outcome.nextCheckInSeconds).toBe(300);
    });

    it('matches the substrings case-insensitively', async () => {
      const outcome = await run({ failure: { throws: 'FEED NOT RECOGNIZED AS RSS' } });

      expect(outcome.update.status).toBe('paused');
      expect(outcome.rethrown).toBeNull();
    });
  });

  describe('transient failures (feed stays in error, job is rethrown so BullMQ retries)', () => {
    it('rethrows an unclassified network error', async () => {
      const outcome = await run({ failure: { throws: 'socket hang up' } });

      expect(outcome.update.status).toBe('error');
      expect(outcome.update.lastError).toBe('socket hang up');
      expect(outcome.rethrown?.message).toBe('socket hang up');
    });

    it('rethrows a 500 rather than pausing the feed', async () => {
      const outcome = await run({ failure: { statusCode: 500 } });

      expect(outcome.update.status).toBe('error');
      expect(outcome.rethrown?.message).toBe('Feed fetch failed with status 500');
    });
  });

  describe('403 threshold (auto-pause only after repeated refusals)', () => {
    it('stays transient below five errors', async () => {
      // feed.errorCount 3 => classification runs with errorCount 4.
      const outcome = await run({ failure: { statusCode: 403 }, errorCount: 3 });

      expect(outcome.update.errorCount).toBe(4);
      expect(outcome.update.status).toBe('error');
      expect(outcome.rethrown).not.toBeNull();
    });

    it('auto-pauses for 14 hours once the fifth error is reached', async () => {
      const outcome = await run({ failure: { statusCode: 403 }, errorCount: 4 });

      expect(outcome.update.errorCount).toBe(5);
      expect(outcome.update.status).toBe('paused');
      expect(outcome.rethrown).toBeNull();
      expect(outcome.update.lastError).toBe('auto-paused: Feed fetch failed with status 403');
      expect(outcome.nextCheckInSeconds).toBe(BLOCKED_AUTO_PAUSE_DELAY_SECONDS);
    });
  });

  describe('DNS threshold (auto-pause only after repeated resolution failures)', () => {
    const dnsMessages = [
      'getaddrinfo ENOTFOUND feeds.example.com',
      'Could not resolve host: feeds.example.com',
      'EAI_AGAIN feeds.example.com',
    ];

    it.each(dnsMessages)('stays transient below three errors for "%s"', async (message) => {
      // feed.errorCount 1 => classification runs with errorCount 2.
      const outcome = await run({ failure: { throws: message }, errorCount: 1 });

      expect(outcome.update.status).toBe('error');
      expect(outcome.rethrown).not.toBeNull();
    });

    it.each(dnsMessages)('auto-pauses for 12 hours from the third error for "%s"', async (message) => {
      const outcome = await run({ failure: { throws: message }, errorCount: 2 });

      expect(outcome.update.errorCount).toBe(3);
      expect(outcome.update.status).toBe('paused');
      expect(outcome.rethrown).toBeNull();
      expect(outcome.update.lastError).toBe(`auto-paused: ${message}`);
      expect(outcome.nextCheckInSeconds).toBe(DNS_AUTO_PAUSE_DELAY_SECONDS);
    });

    it('prefers the terminal 404 branch over the DNS branch when both could match', async () => {
      const outcome = await run({ failure: { throws: 'status 404 after ENOTFOUND retry' }, errorCount: 5 });

      expect(outcome.update.lastError).not.toContain('auto-paused:');
      expect(outcome.nextCheckInSeconds).toBeLessThan(DNS_AUTO_PAUSE_DELAY_SECONDS);
    });
  });

  describe('exponential backoff', () => {
    it('doubles with each consecutive error', async () => {
      const first = await run({ failure: { throws: 'socket hang up' }, errorCount: 0, pollIntervalSeconds: 600 });
      const second = await run({ failure: { throws: 'socket hang up' }, errorCount: 1, pollIntervalSeconds: 600 });
      const third = await run({ failure: { throws: 'socket hang up' }, errorCount: 2, pollIntervalSeconds: 600 });

      expect(first.nextCheckInSeconds).toBe(600);
      expect(second.nextCheckInSeconds).toBe(1_200);
      expect(third.nextCheckInSeconds).toBe(2_400);
    });

    it('caps the exponent at six consecutive errors', async () => {
      const sixth = await run({ failure: { throws: 'socket hang up' }, errorCount: 5, pollIntervalSeconds: 60 });
      const twentieth = await run({ failure: { throws: 'socket hang up' }, errorCount: 19, pollIntervalSeconds: 60 });

      // 60 * 2^5 = 1920s, and the exponent never grows past that.
      expect(sixth.nextCheckInSeconds).toBe(1_920);
      expect(twentieth.nextCheckInSeconds).toBe(1_920);
    });

    it('never schedules the next check more than six hours out', async () => {
      const outcome = await run({
        failure: { throws: 'socket hang up' },
        errorCount: 5,
        pollIntervalSeconds: 6 * HOUR_SECONDS,
      });

      expect(outcome.nextCheckInSeconds).toBe(MAX_ERROR_BACKOFF_SECONDS);
    });
  });

  describe('jitter bounds (Math.random is not stubbed)', () => {
    beforeEach(() => {
      jest.spyOn(Math, 'random').mockRestore();
    });

    it('keeps the error backoff within [base, base + 15 minutes)', async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const outcome = await run({
          failure: { throws: 'socket hang up' },
          errorCount: 5,
          pollIntervalSeconds: 6 * HOUR_SECONDS,
        });

        expect(outcome.nextCheckInSeconds).toBeGreaterThanOrEqual(MAX_ERROR_BACKOFF_SECONDS);
        expect(outcome.nextCheckInSeconds).toBeLessThan(MAX_ERROR_BACKOFF_SECONDS + 15 * 60);
      }
    });

    it('caps the jitter proportionally when the base backoff is small', async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const outcome = await run({ failure: { throws: 'socket hang up' }, errorCount: 0, pollIntervalSeconds: 100 });

        // jitter < max(1, floor(100 * 0.15)) = 15 seconds.
        expect(outcome.nextCheckInSeconds).toBeGreaterThanOrEqual(100);
        expect(outcome.nextCheckInSeconds).toBeLessThan(115);
      }
    });

    it('keeps the auto-pause delay within [base, base + 30 minutes)', async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const outcome = await run({ failure: { statusCode: 403 }, errorCount: 4 });

        expect(outcome.nextCheckInSeconds).toBeGreaterThanOrEqual(BLOCKED_AUTO_PAUSE_DELAY_SECONDS);
        expect(outcome.nextCheckInSeconds).toBeLessThan(BLOCKED_AUTO_PAUSE_DELAY_SECONDS + 30 * 60);
      }
    });
  });
});
