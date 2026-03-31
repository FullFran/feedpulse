import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

type MockResponse = {
  body: Record<string, unknown> | string;
  ok?: boolean;
  status?: number;
  statusText?: string;
  contentType?: string;
};

class FakeElement {
  value = '';
  textContent = '';
  innerHTML = '';
  listeners = new Map<string, (event?: Record<string, unknown>) => void | Promise<void>>();

  addEventListener(type: string, handler: (event?: Record<string, unknown>) => void | Promise<void>) {
    this.listeners.set(type, handler);
  }
}

function createMockFetch(responses: MockResponse[]) {
  return jest.fn(async () => {
    const next = responses.shift();
    if (!next) {
      throw new Error('Unexpected fetch call');
    }

    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      statusText: next.statusText ?? 'OK',
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? next.contentType ?? 'application/json' : null),
      },
      json: async () => next.body,
      text: async () => String(next.body),
    };
  });
}

function createHarness(responses: MockResponse[]) {
  const ids = [
    'api-key',
    'save-key',
    'refresh',
    'auth-feedback',
    'summary',
    'entries-filter',
    'from',
    'to',
    'search',
    'page-size',
    'entries-meta',
    'entries-body',
  ] as const;

  const elements = new Map<string, FakeElement>(ids.map((id) => [id, new FakeElement()]));
  const fetch = createMockFetch(responses);
  const storage = new Map<string, string>();

  const context = vm.createContext({
    fetch,
    URLSearchParams,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    document: {
      getElementById: (id: string) => {
        const element = elements.get(id);
        if (!element) throw new Error(`Unknown element ${id}`);
        return element;
      },
    },
    Date,
    Promise,
    console,
  });

  const script = readFileSync(join(process.cwd(), 'public', 'dashboard', 'app.js'), 'utf8');
  vm.runInContext(script, context);

  return { elements, fetch, storage };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('dashboard client', () => {
  it('shows summary and entries after saving API key', async () => {
    const harness = createHarness([
      { ok: false, status: 401, statusText: 'Unauthorized', body: { message: 'missing_api_key' } },
      { body: { data: { feedsTotal: 10, feedsActive: 9, feedsError: 1, entries24h: 4, entries7d: 12, alertsPending: 2 } } },
      { body: { data: [{ id: '1', title: 'hello', link: 'https://x', feedId: 1, publishedAt: '2026-03-31T00:00:00.000Z', fetchedAt: '2026-03-31T00:00:00.000Z' }], meta: { total: 1 } } },
    ]);

    const apiKey = harness.elements.get('api-key');
    const saveKey = harness.elements.get('save-key');
    const feedback = harness.elements.get('auth-feedback');
    if (!apiKey || !saveKey || !feedback) throw new Error('missing element');

    await flush();
    apiKey.value = 'ak_test';
    const click = saveKey.listeners.get('click');
    if (!click) throw new Error('click listener missing');
    await click();
    await flush();

    expect(harness.storage.get('rss-dashboard-api-key')).toBe('ak_test');
    expect(feedback.textContent).toBe('OK');
  });

  it('surfaces API error in feedback', async () => {
    const harness = createHarness([
      { ok: false, status: 401, statusText: 'Unauthorized', body: { message: 'missing_api_key' } },
      { ok: false, status: 500, statusText: 'Internal Server Error', body: { message: 'boom' } },
    ]);

    const apiKey = harness.elements.get('api-key');
    const saveKey = harness.elements.get('save-key');
    const feedback = harness.elements.get('auth-feedback');
    if (!apiKey || !saveKey || !feedback) throw new Error('missing element');

    await flush();
    apiKey.value = 'ak_test';
    const click = saveKey.listeners.get('click');
    if (!click) throw new Error('click listener missing');
    await click();
    await flush();

    expect(feedback.textContent).toContain('Error: boom');
  });
});
