/**
 * Loads a small demonstration dataset into a running FeedPulse instance.
 *
 *   npm run demo:seed
 *
 * Everything goes through the public HTTP API rather than straight into
 * Postgres, so the seed exercises exactly the validation, SSRF and quota paths a
 * real caller hits. A row that appears after seeding is a row the API accepted.
 *
 * The script is strictly additive and safe to re-run:
 *  - feeds are deduplicated by URL, and the 409 `feed_already_exists` a repeat
 *    registration returns is reported as "already present" instead of failing;
 *  - rules go through `POST /api/v1/rules/batch`, which is create-only by
 *    contract and answers with the names it skipped.
 *
 * Configuration (all optional):
 *   DEMO_API_BASE_URL   Base URL of the API. Default http://127.0.0.1:$PORT,
 *                       falling back to port 3000.
 *   DEMO_API_KEY        API key sent as `x-api-key`. Defaults to
 *                       BOOTSTRAP_API_KEY from `.env`. Omit it entirely when the
 *                       instance runs with ENABLE_AUTH=false.
 *   DEMO_SKIP_CHECK_NOW Set to `true` to skip the immediate fetch requested for
 *                       each feed after registration.
 */
import 'dotenv/config';

/** Poll interval requested for every demo feed, in seconds. Inside the API's 300-10800 range. */
const DEMO_POLL_INTERVAL_SECONDS = 1800;

interface DemoFeed {
  /** Feed URL, registered verbatim. */
  readonly url: string;
  /** Shown in the run summary so the output reads as a list of sources, not of URLs. */
  readonly label: string;
}

interface DemoRule {
  readonly name: string;
  readonly includeKeywords: string[];
  readonly excludeKeywords: string[];
}

/**
 * Public, high-volume feeds. They are picked so the dashboard has visible
 * traffic within a poll or two and so the keyword rules below actually match
 * something, which is the whole point of a demo dataset.
 */
const DEMO_FEEDS: readonly DemoFeed[] = [
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', label: 'BBC News - World' },
  { url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', label: 'BBC News - Technology' },
  { url: 'https://hnrss.org/frontpage', label: 'Hacker News - Front page' },
  { url: 'https://github.blog/feed/', label: 'The GitHub Blog' },
  { url: 'https://blog.rust-lang.org/feed.xml', label: 'Rust Blog' },
  { url: 'https://arstechnica.com/feed/', label: 'Ars Technica' },
];

/**
 * Two rules, one of each shape the matcher supports: a plain include list, and
 * an include list narrowed by an exclude list. Keywords are matched as full
 * normalized phrases, so they are written the way a headline would carry them.
 */
const DEMO_RULES: readonly DemoRule[] = [
  {
    name: 'Demo - AI releases',
    includeKeywords: ['artificial intelligence', 'machine learning', 'large language model'],
    excludeKeywords: [],
  },
  {
    name: 'Demo - Security advisories',
    includeKeywords: ['security advisory', 'vulnerability', 'data breach'],
    excludeKeywords: ['job posting'],
  },
];

function resolveBaseUrl(): string {
  const configured = process.env.DEMO_API_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }

  const port = process.env.PORT?.trim() || '3000';
  return `http://127.0.0.1:${port}`;
}

function resolveApiKey(): string {
  return (process.env.DEMO_API_KEY ?? process.env.BOOTSTRAP_API_KEY ?? '').trim();
}

function isTruthyFlag(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
  readonly rawBody: string;
}

function readString(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }

  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function readRecord(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) {
    return undefined;
  }

  return (source as Record<string, unknown>)[key];
}

/** Pulls the machine-readable `code` out of the standard error envelope. */
function errorCode(response: ApiResponse): string {
  return readString(response.body, 'code') ?? '';
}

function describeFailure(context: string, response: ApiResponse): Error {
  const code = errorCode(response);
  const message = readString(response.body, 'message') ?? response.rawBody.slice(0, 200);
  const detail = code ? `${code}: ${message}` : message;
  return new Error(`${context} failed with HTTP ${response.status} (${detail})`);
}

class DemoApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async request(method: string, path: string, payload?: unknown): Promise<ApiResponse> {
    const headers: Record<string, string> = { accept: 'application/json' };

    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }

    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });

    const rawBody = await response.text();
    let body: unknown;

    try {
      body = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      body = undefined;
    }

    return { status: response.status, body, rawBody };
  }
}

/**
 * Fails early with an actionable message instead of letting every subsequent
 * request 401 or ECONNREFUSED one at a time.
 */
async function assertApiReachable(client: DemoApiClient, baseUrl: string): Promise<void> {
  let health: ApiResponse;

  try {
    health = await client.request('GET', '/health');
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot reach the FeedPulse API at ${baseUrl} (${reason}).\n` +
        'Start it first with `make dev` (host) or `make up` (Docker), or point DEMO_API_BASE_URL at a running instance.',
      { cause: error },
    );
  }

  if (health.status !== 200) {
    throw describeFailure(`GET ${baseUrl}/health`, health);
  }

  // `/health` is unauthenticated, so it proves the process is up but says
  // nothing about the credential. Probe one authenticated route for that.
  const probe = await client.request('GET', '/api/v1/feeds?page=1&page_size=1');
  if (probe.status === 401 || probe.status === 403) {
    throw new Error(
      `The API at ${baseUrl} rejected the demo credential (HTTP ${probe.status}: ${errorCode(probe)}).\n` +
        'Set DEMO_API_KEY to a valid key, or mint one with `npm run apikey:create -- --tenant legacy --label demo`.',
    );
  }

  if (probe.status !== 200) {
    throw describeFailure('GET /api/v1/feeds', probe);
  }
}

interface FeedSeedResult {
  readonly created: { id: number; label: string }[];
  readonly existing: string[];
}

async function seedFeeds(client: DemoApiClient): Promise<FeedSeedResult> {
  const created: { id: number; label: string }[] = [];
  const existing: string[] = [];

  for (const feed of DEMO_FEEDS) {
    const response = await client.request('POST', '/api/v1/feeds', {
      url: feed.url,
      poll_interval_seconds: DEMO_POLL_INTERVAL_SECONDS,
      status: 'active',
    });

    if (response.status === 201) {
      const id = readRecord(readRecord(response.body, 'data'), 'id');
      created.push({ id: typeof id === 'number' ? id : -1, label: feed.label });
      console.log(`  created  ${feed.label}`);
      continue;
    }

    // Re-running the seed is a supported workflow, not an error: the repository
    // answers 409 `feed_already_exists` on the normalized-URL unique index.
    if (response.status === 409 && errorCode(response) === 'feed_already_exists') {
      existing.push(feed.label);
      console.log(`  present  ${feed.label}`);
      continue;
    }

    throw describeFailure(`POST /api/v1/feeds (${feed.url})`, response);
  }

  return { created, existing };
}

interface RuleSeedSummary {
  readonly createdNames: string[];
  readonly skippedNames: string[];
}

async function seedRules(client: DemoApiClient): Promise<RuleSeedSummary> {
  const response = await client.request('POST', '/api/v1/rules/batch', {
    rules: DEMO_RULES.map((rule) => ({
      name: rule.name,
      include_keywords: rule.includeKeywords,
      exclude_keywords: rule.excludeKeywords,
      is_active: true,
    })),
  });

  if (response.status !== 201) {
    throw describeFailure('POST /api/v1/rules/batch', response);
  }

  const data = readRecord(response.body, 'data');
  const createdRaw = readRecord(data, 'created');
  const skippedRaw = readRecord(data, 'skippedNames');

  const createdNames = Array.isArray(createdRaw)
    ? createdRaw.map((item) => readString(item, 'name') ?? '(unnamed)')
    : [];
  const skippedNames = Array.isArray(skippedRaw) ? skippedRaw.map((item) => String(item)) : [];

  for (const name of createdNames) {
    console.log(`  created  ${name}`);
  }
  for (const name of skippedNames) {
    console.log(`  present  ${name}`);
  }

  return { createdNames, skippedNames };
}

/**
 * Asks the API to fetch each newly registered feed immediately so the demo has
 * entries within seconds instead of one scheduler tick later.
 *
 * Best effort by design: it needs the worker and Redis, and it is subject to the
 * tighter write rate limit. A failure here leaves a fully seeded instance whose
 * feeds are simply picked up on the next tick, so it never fails the run.
 */
async function requestImmediateChecks(client: DemoApiClient, feedIds: number[]): Promise<void> {
  let queued = 0;

  for (const id of feedIds) {
    if (id < 0) {
      continue;
    }

    try {
      const response = await client.request('POST', `/api/v1/feeds/${id}/check-now`);
      if (response.status === 202) {
        queued += 1;
      } else {
        console.warn(`  warning: check-now for feed ${id} returned HTTP ${response.status} (${errorCode(response)})`);
      }
    } catch (error: unknown) {
      console.warn(
        `  warning: check-now for feed ${id} failed (${error instanceof Error ? error.message : 'unknown'})`,
      );
    }
  }

  console.log(`  queued an immediate check for ${queued} of ${feedIds.length} new feed(s)`);
}

async function run(): Promise<void> {
  const baseUrl = resolveBaseUrl();
  const client = new DemoApiClient(baseUrl, resolveApiKey());

  console.log(`Seeding demo data into ${baseUrl}`);
  await assertApiReachable(client, baseUrl);

  console.log('\nFeeds:');
  const feeds = await seedFeeds(client);

  console.log('\nRules:');
  const rules = await seedRules(client);

  if (feeds.created.length > 0 && !isTruthyFlag(process.env.DEMO_SKIP_CHECK_NOW)) {
    console.log('\nImmediate checks:');
    await requestImmediateChecks(
      client,
      feeds.created.map((feed) => feed.id),
    );
  }

  console.log(
    `\nDone. Feeds: ${feeds.created.length} created, ${feeds.existing.length} already present. ` +
      `Rules: ${rules.createdNames.length} created, ${rules.skippedNames.length} already present.`,
  );
  console.log(`Open ${baseUrl}/dashboard/ to see them.`);
}

void run().catch((error: unknown) => {
  console.error(`\nDemo seed failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
