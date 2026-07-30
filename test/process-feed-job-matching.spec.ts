import { createHash } from 'node:crypto';
import type { AlertUpsertOutcome } from '../src/modules/alerts/alerts.repository';
import { ProcessFeedJobUseCase } from '../src/modules/ingestion/application/process-feed-job.use-case';
import { expectDefined } from './support/expect-defined';

interface FeedItem {
  title: string;
  link: string;
  guid?: string;
  description: string;
  pubDate?: string;
}

function buildFeed(items: FeedItem[]): string {
  const renderedItems = items
    .map(
      (item) => `
        <item>
          <title>${item.title}</title>
          <link>${item.link}</link>
          ${item.guid === undefined ? '' : `<guid>${item.guid}</guid>`}
          <description>${item.description}</description>
          ${item.pubDate === undefined ? '' : `<pubDate>${item.pubDate}</pubDate>`}
        </item>`,
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0">
      <channel>
        <title>Test Feed</title>
        ${renderedItems}
      </channel>
    </rss>`;
}

interface HarnessOptions {
  rules: Array<{ id: number; includeKeywords: string[]; excludeKeywords: string[] }>;
  items: FeedItem[];
}

interface InsertedEntryRecord {
  title: string | null;
  link: string | null;
  guid: string | null;
  content: string | null;
  contentHash: string;
  publishedAt: string | null;
}

function createHarness(options: HarnessOptions) {
  const insertedEntries: InsertedEntryRecord[] = [];
  const matchCalls: Array<Map<string, number[]>> = [];
  const deliveredAlertIds: number[] = [];
  let alertsGenerated = 0;

  const queryExecutor = { query: async () => ({ rows: [] as unknown[], rowCount: 0 }) };

  const databaseService = {
    query: queryExecutor.query,
    getPool: () => ({
      connect: async () => ({
        query: async () => ({ rows: [], rowCount: 0 }),
        release: () => undefined,
      }),
    }),
  };

  const entriesRepository = {
    insertMany: async (
      _tenantId: string,
      _feedId: number,
      entries: InsertedEntryRecord[],
    ): Promise<Array<InsertedEntryRecord & { id: string }>> => {
      insertedEntries.push(...entries);
      return entries.map((entry, index) => ({ ...entry, id: String(index + 1) }));
    },
  };

  const alertsRepository = {
    createForEntryWithRules: async (matchesByEntry: Map<string, number[]>): Promise<AlertUpsertOutcome> => {
      matchCalls.push(new Map(matchesByEntry));
      return {
        created: [...matchesByEntry.entries()].map(([entryId, ruleIds]) => ({
          id: entryId,
          entryId,
          ruleId: expectDefined(ruleIds[0]),
        })),
        ruleSetExtended: [],
      };
    },
  };

  const useCase = new ProcessFeedJobUseCase(
    { assertSchemaReady: async () => undefined } as never,
    databaseService as never,
    {
      findByIdForWorker: async () => ({
        id: 7,
        tenantId: 'tenant_a',
        url: 'https://example.com/rss.xml',
        etag: null,
        lastModified: null,
        pollIntervalSeconds: 300,
        errorCount: 0,
      }),
      updateAfterFetch: async () => undefined,
    } as never,
    entriesRepository as never,
    { listActive: async () => options.rules.map((rule) => ({ ...rule, name: `Rule ${rule.id}` })) } as never,
    alertsRepository as never,
    { execute: async (alertId: number) => deliveredAlertIds.push(alertId) } as never,
    { fetchTimeoutMs: 1000 } as never,
    {
      observeFetchDuration: () => undefined,
      incrementEntriesInserted: () => undefined,
      incrementAlertsGenerated: (count: number) => {
        alertsGenerated += count;
      },
      incrementFetchErrors: () => undefined,
    } as never,
    {
      fetch: async () => ({
        statusCode: 200,
        durationMs: 5,
        etag: null,
        lastModified: null,
        body: buildFeed(options.items),
      }),
    },
  );

  return {
    useCase,
    insertedEntries,
    deliveredAlertIds,
    get matchesByEntry() {
      return matchCalls[matchCalls.length - 1] ?? new Map<string, number[]>();
    },
    get alertsGenerated() {
      return alertsGenerated;
    },
  };
}

describe('ProcessFeedJobUseCase rule matching', () => {
  it('matches a rule when ANY include keyword is present (documented any-of semantics)', async () => {
    const harness = createHarness({
      rules: [{ id: 1, includeKeywords: ['AI', 'LLM'], excludeKeywords: [] }],
      items: [
        {
          title: 'AI launch update',
          link: 'https://example.com/1',
          guid: 'a',
          description: 'No mention of the other word.',
        },
        {
          title: 'Quarterly earnings',
          link: 'https://example.com/2',
          guid: 'b',
          description: 'Nothing relevant here.',
        },
      ],
    });

    await harness.useCase.execute({ feedId: 7 });

    expect([...harness.matchesByEntry.entries()]).toEqual([['1', [1]]]);
  });

  it('does not turn a rule with no include keywords into a match-all', async () => {
    const harness = createHarness({
      rules: [{ id: 1, includeKeywords: [], excludeKeywords: [] }],
      items: [{ title: 'Anything at all', link: 'https://example.com/1', guid: 'a', description: 'Body text.' }],
    });

    const result = await harness.useCase.execute({ feedId: 7 });

    expect(harness.matchesByEntry.size).toBe(0);
    expect(result.createdAlerts).toBe(0);
  });

  it('lets any exclude keyword veto a rule', async () => {
    const harness = createHarness({
      rules: [{ id: 1, includeKeywords: ['ocupacion'], excludeKeywords: ['turistica'] }],
      items: [
        {
          title: 'Ocupación turística en la costa',
          link: 'https://example.com/1',
          guid: 'a',
          description: 'Must be excluded.',
        },
        { title: 'Ocupación ilegal en Sevilla', link: 'https://example.com/2', guid: 'b', description: 'Must match.' },
      ],
    });

    await harness.useCase.execute({ feedId: 7 });

    expect([...harness.matchesByEntry.entries()]).toEqual([['2', [1]]]);
  });

  it('aggregates every matching rule into a single entry match', async () => {
    const harness = createHarness({
      rules: [
        { id: 1, includeKeywords: ['ocupacion'], excludeKeywords: [] },
        { id: 2, includeKeywords: ['vivienda'], excludeKeywords: [] },
        { id: 3, includeKeywords: ['desahucio'], excludeKeywords: [] },
      ],
      items: [
        {
          title: 'Ocupación de una vivienda en el centro',
          link: 'https://example.com/1',
          guid: 'a',
          description: 'Confirmed case.',
        },
      ],
    });

    await harness.useCase.execute({ feedId: 7 });

    expect(harness.matchesByEntry.get('1')).toEqual([1, 2]);
  });

  it('does not match a keyword that only appears inside a longer word', async () => {
    const harness = createHarness({
      rules: [{ id: 1, includeKeywords: ['ocupacion'], excludeKeywords: [] }],
      items: [
        {
          title: 'Crece la preocupación ciudadana',
          link: 'https://example.com/1',
          guid: 'a',
          // Spanish fixture on purpose: "preocupación" and "ocupacional" are the
          // real-world substring traps the word-boundary matcher has to survive.
          description: 'La residencia apuesta por la terapia ocupacional.',
        },
      ],
    });

    await harness.useCase.execute({ feedId: 7 });

    expect(harness.matchesByEntry.size).toBe(0);
  });

  it('hashes link, guid and published instant so a revised headline is the same entry', async () => {
    const first = createHarness({
      rules: [],
      items: [
        {
          title: 'Original headline',
          link: 'https://example.com/1',
          guid: 'guid-1',
          description: 'Body',
          pubDate: 'Fri, 20 Mar 2026 09:00:00 GMT',
        },
      ],
    });
    const second = createHarness({
      rules: [],
      items: [
        {
          title: 'Revised headline after publication',
          link: 'https://example.com/1',
          guid: 'guid-1',
          description: 'Body',
          pubDate: 'Fri, 20 Mar 2026 09:00:00 GMT',
        },
      ],
    });

    await first.useCase.execute({ feedId: 7 });
    await second.useCase.execute({ feedId: 7 });

    const expected = createHash('sha256').update('https://example.com/1|guid-1|2026-03-20T09:00:00.000Z').digest('hex');

    expect(expectDefined(first.insertedEntries[0]).contentHash).toBe(expected);
    expect(expectDefined(second.insertedEntries[0]).contentHash).toBe(expected);
  });

  it('normalizes the published timestamp to a UTC ISO instant and drops unparseable ones', async () => {
    const harness = createHarness({
      rules: [],
      items: [
        {
          title: 'Dated',
          link: 'https://example.com/1',
          guid: 'a',
          description: 'Body',
          pubDate: 'Fri, 20 Mar 2026 09:00:00 GMT',
        },
        { title: 'Undated', link: 'https://example.com/2', guid: 'b', description: 'Body', pubDate: 'not a date' },
      ],
    });

    await harness.useCase.execute({ feedId: 7 });

    expect(expectDefined(harness.insertedEntries[0]).publishedAt).toBe('2026-03-20T09:00:00.000Z');
    expect(expectDefined(harness.insertedEntries[1]).publishedAt).toBeNull();
  });

  it('counts and delivers only the alerts the repository actually created', async () => {
    const harness = createHarness({
      rules: [{ id: 1, includeKeywords: ['ai'], excludeKeywords: [] }],
      items: [
        { title: 'AI launch update', link: 'https://example.com/1', guid: 'a', description: 'Body' },
        { title: 'AI funding round', link: 'https://example.com/2', guid: 'b', description: 'Body' },
      ],
    });

    const result = await harness.useCase.execute({ feedId: 7 });

    expect(result.createdAlerts).toBe(2);
    expect(harness.alertsGenerated).toBe(2);
    expect(harness.deliveredAlertIds).toEqual([1, 2]);
  });
});
