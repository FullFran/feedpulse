/// <reference types="node" />

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface HttpResult {
  url: string;
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  bodyJson?: unknown;
}

interface MetricSnapshot {
  raw: string;
  values: Record<string, number>;
}

interface FeedSeedRecord {
  index: number;
  id: number;
  url: string;
}

interface ListEnvelopeMeta {
  total: number;
}

interface FixtureHealth {
  status: string;
  captures: number;
  requests: number;
  rssRequests: number;
  webhookRequests: number;
  uniqueFeedsServed: number;
}

const apiBaseUrl = process.env.BENCHMARK_API_BASE_URL ?? `http://127.0.0.1:${process.env.BENCHMARK_API_HOST_PORT ?? '3400'}`;
const fixturePublicBaseUrl = process.env.BENCHMARK_FIXTURE_PUBLIC_URL ?? `http://127.0.0.1:${process.env.BENCHMARK_MONITORING_PORT ?? '4110'}`;
const fixtureInternalBaseUrl = process.env.BENCHMARK_FIXTURE_INTERNAL_URL ?? 'http://smoke-monitoring:4010';
const artifactsRoot = process.env.BENCHMARK_ARTIFACTS_DIR ?? join(process.cwd(), 'artifacts', 'benchmark');
const stageTargets = parseStageTargets(process.env.BENCHMARK_STAGES ?? '100');
const batchSize = parsePositiveInt(process.env.BENCHMARK_BATCH_SIZE, 25);
const pageSampleSize = parsePositiveInt(process.env.BENCHMARK_SAMPLE_LIMIT, 20);
const pollIntervalMs = parsePositiveInt(process.env.BENCHMARK_POLL_INTERVAL_MS, 2000);
const pollTimeoutMs = parsePositiveInt(process.env.BENCHMARK_TIMEOUT_MS, 180000);
const pollIntervalSeconds = parsePositiveInt(process.env.BENCHMARK_POLL_INTERVAL_SECONDS, 300);
const ruleKeyword = process.env.BENCHMARK_RULE_KEYWORD ?? 'AI';
const runId = createRunId();
const runArtifactsDir = join(artifactsRoot, runId);
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseStageTargets(raw: string): number[] {
  const targets = raw
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (!targets.length) {
    throw new Error(`No valid benchmark stages were parsed from ${raw}`);
  }

  return Array.from(new Set(targets)).sort((left, right) => left - right);
}

function createRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function writeArtifact(dir: string, name: string, value: unknown): Promise<void> {
  const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  await writeFile(join(dir, name), content, 'utf8');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(url: string, init?: RequestInit): Promise<HttpResult> {
  const response = await fetch(url, init);
  const bodyText = await response.text();
  let bodyJson: unknown;

  try {
    bodyJson = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    bodyJson = undefined;
  }

  return {
    url,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    bodyText,
    bodyJson,
  };
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const result = await request(url, init);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Request to ${url} failed with status ${result.status}: ${result.bodyText}`);
  }

  return result.bodyJson as T;
}

async function poll<T>(label: string, fn: () => Promise<T>, timeoutMs = pollTimeoutMs, intervalMs = pollIntervalMs): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await delay(intervalMs);
    }
  }

  throw new Error(`${label} timed out: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function waitForReadiness(): Promise<void> {
  await poll('API readiness', async () => {
    const result = await request(`${apiBaseUrl}/ready`);
    if (result.status !== 200) {
      throw new Error(`ready returned ${result.status}`);
    }
  });

  await poll('fixture health', async () => {
    const result = await request(`${fixturePublicBaseUrl}/health`);
    if (result.status !== 200) {
      throw new Error(`fixture health returned ${result.status}`);
    }
  });
}

async function resetFixtureState(): Promise<void> {
  const [capturesResult, requestsResult] = await Promise.all([
    request(`${fixturePublicBaseUrl}/captures`, { method: 'DELETE' }),
    request(`${fixturePublicBaseUrl}/requests`, { method: 'DELETE' }),
  ]);

  if (capturesResult.status !== 204) {
    throw new Error(`failed to clear fixture captures: ${capturesResult.status}`);
  }

  if (requestsResult.status !== 204) {
    throw new Error(`failed to clear fixture requests: ${requestsResult.status}`);
  }
}

async function readMetrics(): Promise<MetricSnapshot> {
  const result = await request(`${apiBaseUrl}/metrics`);
  if (result.status !== 200) {
    throw new Error(`metrics returned ${result.status}`);
  }

  const values: Record<string, number> = {};
  for (const line of result.bodyText.split('\n')) {
    if (!line || line.startsWith('#')) {
      continue;
    }

    const [name, rawValue] = line.trim().split(/\s+/, 2);
    const value = Number.parseFloat(rawValue);
    if (Number.isFinite(value)) {
      values[name] = value;
    }
  }

  return { raw: result.bodyText, values };
}

async function ensureRule(): Promise<{ id: number; name: string }> {
  const ruleName = `Benchmark ${ruleKeyword} ${runId}`;
  const response = await requestJson<{ data: { id: number; name: string } }>(`${apiBaseUrl}/api/v1/rules`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: ruleName,
      include_keywords: [ruleKeyword],
      exclude_keywords: ['crypto'],
    }),
  });

  return response.data;
}

async function readListTotal(path: string): Promise<number> {
  const response = await requestJson<{ meta: ListEnvelopeMeta }>(`${apiBaseUrl}${path}`);
  return response.meta.total;
}

async function readStageCounts(): Promise<{ feeds: number; entries: number; sentAlerts: number }> {
  const [feeds, entries, sentAlerts] = await Promise.all([
    readListTotal('/api/v1/feeds?page=1&page_size=1'),
    readListTotal('/api/v1/entries?page=1&page_size=1'),
    readListTotal('/api/v1/alerts?page=1&page_size=1&sent=true'),
  ]);

  return { feeds, entries, sentAlerts };
}

async function createFeed(index: number): Promise<FeedSeedRecord> {
  const url = `${fixtureInternalBaseUrl}/feeds/feed-${index.toString().padStart(5, '0')}/rss.xml`;
  const response = await requestJson<{ data: { id: number } }>(`${apiBaseUrl}/api/v1/feeds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url,
      poll_interval_seconds: pollIntervalSeconds,
    }),
  });

  return {
    index,
    id: response.data.id,
    url,
  };
}

async function runInBatches<T>(items: number[], worker: (value: number) => Promise<T>): Promise<T[]> {
  const results: T[] = [];

  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    const batchResults = await Promise.all(batch.map((value) => worker(value)));
    results.push(...batchResults);
  }

  return results;
}

async function queueFeeds(feeds: FeedSeedRecord[]): Promise<void> {
  await runInBatches(
    feeds.map((feed) => feed.id),
    async (feedId) => {
      const result = await request(`${apiBaseUrl}/api/v1/feeds/${feedId}/check-now`, { method: 'POST' });
      if (result.status !== 202) {
        throw new Error(`check-now failed for feed ${feedId}: ${result.status} ${result.bodyText}`);
      }

      return feedId;
    },
  );
}

async function readFixtureHealth(): Promise<FixtureHealth> {
  return requestJson<FixtureHealth>(`${fixturePublicBaseUrl}/health`);
}

async function readFixtureSample(path: 'captures' | 'requests'): Promise<unknown> {
  return requestJson(`${fixturePublicBaseUrl}/${path}?limit=${pageSampleSize}`);
}

async function runStage(targetFeeds: number, alreadySeeded: number): Promise<{ summary: Record<string, unknown>; seededFeeds: number }> {
  const stageDir = join(runArtifactsDir, `stage-${targetFeeds}`);
  await ensureDir(stageDir);

  const feedsToAdd = targetFeeds - alreadySeeded;
  if (feedsToAdd <= 0) {
    throw new Error(`Stage ${targetFeeds} does not add any new feeds after ${alreadySeeded} were already seeded`);
  }

  await resetFixtureState();
  const metricsBefore = await readMetrics();
  const countsBefore = await readStageCounts();
  await writeArtifact(stageDir, 'metrics-before.prom', metricsBefore.raw);
  await writeArtifact(stageDir, 'counts-before.json', countsBefore);

  const seedIndexes = Array.from({ length: feedsToAdd }, (_, offset) => alreadySeeded + offset + 1);
  const seedStartedAt = Date.now();
  const createdFeeds = await runInBatches(seedIndexes, createFeed);
  const seedDurationMs = Date.now() - seedStartedAt;

  await writeArtifact(stageDir, 'seed-sample.json', {
    count: createdFeeds.length,
    sample: createdFeeds.slice(0, pageSampleSize),
  });

  const queueStartedAt = Date.now();
  await queueFeeds(createdFeeds);
  const queueDurationMs = Date.now() - queueStartedAt;

  const completionStartedAt = Date.now();
  const completion = await poll(`benchmark stage ${targetFeeds}`, async () => {
    const [health, metrics, counts] = await Promise.all([readFixtureHealth(), readMetrics(), readStageCounts()]);
    const feedsDelta = counts.feeds - countsBefore.feeds;
    const entriesDelta = counts.entries - countsBefore.entries;
    const sentDelta = counts.sentAlerts - countsBefore.sentAlerts;

    if (health.rssRequests < feedsToAdd) {
      throw new Error(`waiting for rss requests ${health.rssRequests}/${feedsToAdd}`);
    }

    if (health.captures < feedsToAdd) {
      throw new Error(`waiting for webhook captures ${health.captures}/${feedsToAdd}`);
    }

    if (feedsDelta < feedsToAdd || entriesDelta < feedsToAdd || sentDelta < feedsToAdd) {
      throw new Error(
        `waiting for API totals feeds=${feedsDelta}/${feedsToAdd} entries=${entriesDelta}/${feedsToAdd} sent=${sentDelta}/${feedsToAdd}`,
      );
    }

    return {
      health,
      metrics,
      counts,
      deltas: {
        feedsRegistered: feedsDelta,
        entriesIngested: entriesDelta,
        alertsSent: sentDelta,
      },
    };
  });
  const processingDurationMs = Date.now() - completionStartedAt;

  await writeArtifact(stageDir, 'metrics-after.prom', completion.metrics.raw);
  await writeArtifact(stageDir, 'counts-after.json', completion.counts);
  await writeArtifact(stageDir, 'fixture-health.json', completion.health);
  await writeArtifact(stageDir, 'fixture-requests-sample.json', await readFixtureSample('requests'));
  await writeArtifact(stageDir, 'fixture-captures-sample.json', await readFixtureSample('captures'));

  const summary = {
    stageTargetFeeds: targetFeeds,
    feedsAddedThisStage: feedsToAdd,
    totalFeedsSeeded: targetFeeds,
    batchSize,
    pollIntervalSeconds,
    seedDurationMs,
    queueDurationMs,
    processingDurationMs,
    totalStageDurationMs: seedDurationMs + queueDurationMs + processingDurationMs,
    fixtureHealth: completion.health,
    metricsDelta: completion.deltas,
    sampleFeedIds: createdFeeds.slice(0, pageSampleSize).map((feed) => feed.id),
  };

  await writeArtifact(stageDir, 'stage-summary.json', summary);
  return { summary, seededFeeds: targetFeeds };
}

async function main(): Promise<void> {
  await ensureDir(runArtifactsDir);
  await waitForReadiness();

  const state: Record<string, unknown> = {
    runId,
    apiBaseUrl,
    fixturePublicBaseUrl,
    fixtureInternalBaseUrl,
    stageTargets,
    batchSize,
    pollIntervalSeconds,
  };

  try {
    const rule = await ensureRule();
    state.rule = rule;
    await writeArtifact(runArtifactsDir, 'run-config.json', state);

    let seededFeeds = 0;
    const stageSummaries: Array<Record<string, unknown>> = [];

    for (const targetFeeds of stageTargets) {
      const stageResult = await runStage(targetFeeds, seededFeeds);
      seededFeeds = stageResult.seededFeeds;
      stageSummaries.push(stageResult.summary);
      console.log(
        `Benchmark stage ${targetFeeds} complete: added ${stageResult.summary.feedsAddedThisStage} feeds in ${stageResult.summary.totalStageDurationMs} ms.`,
      );
    }

    await writeArtifact(runArtifactsDir, 'benchmark-summary.json', {
      status: 'passed',
      runId,
      stages: stageSummaries,
      note: 'Stages are cumulative within one fresh benchmark run; each stage adds only the delta from the prior completed stage.',
    });
  } catch (error) {
    state.status = 'failed';
    state.error = error instanceof Error ? error.message : String(error);
    await writeArtifact(runArtifactsDir, 'benchmark-failure.json', state);
    throw error;
  }
}

void main();
