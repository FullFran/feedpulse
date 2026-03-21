/// <reference types="node" />

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

interface HttpResult {
  url: string;
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  bodyJson?: unknown;
}

interface AlertRecord {
  id: string;
  sent: boolean;
  deliveryStatus: string;
  rule: {
    name: string;
  };
}

const apiBaseUrl = process.env.SMOKE_API_BASE_URL ?? 'http://127.0.0.1:3000';
const fixturePublicBaseUrl = process.env.SMOKE_FIXTURE_PUBLIC_URL ?? `http://127.0.0.1:${process.env.SMOKE_MONITORING_PORT ?? '4010'}`;
const fixtureInternalBaseUrl = process.env.SMOKE_FIXTURE_INTERNAL_URL ?? 'http://smoke-monitoring:4010';
const artifactsDir = process.env.SMOKE_ARTIFACTS_DIR ?? join(process.cwd(), 'artifacts', 'smoke');
const composeProject = process.env.SMOKE_COMPOSE_PROJECT ?? 'rss-monitor-smoke';
const composeArgs = ['compose', '-p', composeProject, '-f', 'docker-compose.yml', '-f', 'docker-compose.smoke.yml'];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resetArtifacts(): Promise<void> {
  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(artifactsDir, { recursive: true });
}

async function writeArtifact(name: string, value: unknown): Promise<void> {
  const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  await writeFile(join(artifactsDir, name), content, 'utf8');
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

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const result = await request(url, init);

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Request to ${url} failed with status ${result.status}: ${result.bodyText}`);
  }

  return result.bodyJson;
}

async function poll<T>(label: string, fn: () => Promise<T>, timeoutMs = 60000, intervalMs = 2000): Promise<T> {
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

async function runDockerCompose(commandArgs: string[]): Promise<void> {
  const result = spawnSync('docker', [...composeArgs, ...commandArgs], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`docker ${composeArgs.join(' ')} ${commandArgs.join(' ')} exited with code ${result.status ?? 'unknown'}`);
  }
}

async function waitForFixture(): Promise<void> {
  await poll('smoke fixture health', async () => {
    const result = await request(`${fixturePublicBaseUrl}/health`);

    if (result.status !== 200) {
      throw new Error(`fixture health returned ${result.status}`);
    }

    return undefined;
  });
}

async function clearFixtureCaptures(): Promise<void> {
  const result = await request(`${fixturePublicBaseUrl}/captures`, { method: 'DELETE' });

  if (result.status !== 204) {
    throw new Error(`failed to clear fixture captures: ${result.status}`);
  }
}

async function probeEndpoints(): Promise<Record<string, unknown>> {
  const health = await poll('API health', async () => {
    const result = await request(`${apiBaseUrl}/health`);
    if (result.status !== 200) {
      throw new Error(`health returned ${result.status}`);
    }
    return result;
  });

  const ready = await poll('API readiness', async () => {
    const result = await request(`${apiBaseUrl}/ready`);
    if (result.status !== 200) {
      throw new Error(`ready returned ${result.status}`);
    }
    return result;
  });

  const docs = await request(`${apiBaseUrl}/docs`);
  if (docs.status !== 200 || !docs.bodyText.includes('swagger-ui')) {
    throw new Error('Swagger UI endpoint did not return the expected body');
  }

  const docsJson = await request(`${apiBaseUrl}/docs-json`);
  const docsJsonBody = docsJson.bodyJson as { paths?: Record<string, unknown> } | undefined;
  if (docsJson.status !== 200 || !docsJsonBody?.paths?.['/health'] || !docsJsonBody.paths['/ready']) {
    throw new Error('OpenAPI JSON is missing required observability paths');
  }

  const dashboardRedirect = await request(`${apiBaseUrl}/dashboard`, { redirect: 'manual' });
  if (dashboardRedirect.status !== 301 || dashboardRedirect.headers.location !== '/dashboard/') {
    throw new Error('Dashboard redirect did not match the expected mount path');
  }

  const dashboard = await request(`${apiBaseUrl}/dashboard/`);
  if (dashboard.status !== 200 || !dashboard.bodyText.includes('RSS Monitor Dashboard')) {
    throw new Error('Dashboard index did not contain the expected title');
  }

  return {
    health,
    ready,
    docs: {
      ...docs,
      bodyText: docs.bodyText.slice(0, 500),
    },
    docsJson,
    dashboardRedirect,
    dashboard: {
      ...dashboard,
      bodyText: dashboard.bodyText.slice(0, 500),
    },
  };
}

async function createSmokeEntities(runId: string): Promise<{ ruleName: string; feedId: number; feedUrl: string }> {
  const ruleName = `Smoke AI ${runId}`;
  const ruleResponse = (await requestJson(`${apiBaseUrl}/api/v1/rules`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: ruleName,
      include_keywords: ['AI'],
      exclude_keywords: ['crypto'],
    }),
  })) as { data: { name: string } };

  if (ruleResponse.data.name !== ruleName) {
    throw new Error('Rule creation response did not match the requested rule name');
  }

  const feedUrl = `${fixtureInternalBaseUrl}/rss.xml?runId=${encodeURIComponent(runId)}`;
  const feedResponse = (await requestJson(`${apiBaseUrl}/api/v1/feeds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: feedUrl,
      poll_interval_seconds: 300,
    }),
  })) as { data: { id: number } };

  await requestJson(`${apiBaseUrl}/api/v1/feeds/${feedResponse.data.id}/check-now`, {
    method: 'POST',
  });

  return {
    ruleName,
    feedId: feedResponse.data.id,
    feedUrl,
  };
}

async function waitForSentAlert(ruleName: string): Promise<{ alert: AlertRecord; alertsResponse: unknown }> {
  return poll('sent alert', async () => {
    const alertsResponse = (await requestJson(`${apiBaseUrl}/api/v1/alerts?page=1&page_size=100`)) as {
      data: AlertRecord[];
    };
    const alert = alertsResponse.data.find((candidate) => candidate.rule.name === ruleName && candidate.sent && candidate.deliveryStatus === 'sent');

    if (!alert) {
      throw new Error(`No sent alert found yet for rule ${ruleName}`);
    }

    return { alert, alertsResponse };
  }, 90000, 3000);
}

async function waitForWebhookCapture(ruleName: string): Promise<unknown> {
  return poll('webhook capture', async () => {
    const captures = (await requestJson(`${fixturePublicBaseUrl}/captures`)) as {
      items: Array<{ parsedBody?: { alert?: { rule?: { name?: string } } } }>;
    };
    const matched = captures.items.find((candidate) => candidate.parsedBody?.alert?.rule?.name === ruleName);

    if (!matched) {
      throw new Error(`No webhook capture found yet for rule ${ruleName}`);
    }

    return captures;
  }, 90000, 3000);
}

async function collectFixtureRequests(): Promise<unknown> {
  return requestJson(`${fixturePublicBaseUrl}/requests`);
}

async function main(): Promise<void> {
  await resetArtifacts();

  const runId = `${Date.now()}`;
  const state: Record<string, unknown> = { runId, apiBaseUrl, fixturePublicBaseUrl, fixtureInternalBaseUrl };

  try {
    await waitForFixture();
    await clearFixtureCaptures();
    await runDockerCompose(['run', '--rm', 'api', 'node', 'dist/scripts/migrate.js']);

    const probes = await probeEndpoints();
    state.probes = probes;
    await writeArtifact('endpoint-probes.json', probes);

    const entities = await createSmokeEntities(runId);
    state.entities = entities;
    await writeArtifact('seeded-entities.json', entities);

    const sentAlert = await waitForSentAlert(entities.ruleName);
    state.alert = sentAlert;
    await writeArtifact('alerts.json', sentAlert.alertsResponse);

    const captures = await waitForWebhookCapture(entities.ruleName);
    state.captures = captures;
    await writeArtifact('receiver-captures.json', captures);

    const receiverRequests = await collectFixtureRequests();
    state.receiverRequests = receiverRequests;
    await writeArtifact('receiver-requests.json', receiverRequests);

    await writeArtifact('smoke-summary.json', {
      status: 'passed',
      runId,
      ruleName: entities.ruleName,
      feedId: entities.feedId,
      feedUrl: entities.feedUrl,
      alertId: sentAlert.alert.id,
    });

    console.log(`Smoke stack verification passed for rule ${entities.ruleName} and alert ${sentAlert.alert.id}.`);
  } catch (error) {
    state.status = 'failed';
    state.error = error instanceof Error ? error.message : String(error);

    try {
      state.captures = await requestJson(`${fixturePublicBaseUrl}/captures`);
      state.receiverRequests = await collectFixtureRequests();
    } catch {
      // Best-effort failure artifact capture.
    }

    await writeArtifact('smoke-failure.json', state);
    throw error;
  }
}

void main();
