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

class FakeClassList {
  private readonly classes = new Set<string>();

  add(name: string) {
    this.classes.add(name);
  }

  remove(name: string) {
    this.classes.delete(name);
  }

  toggle(name: string, force?: boolean) {
    if (force === true) {
      this.classes.add(name);
      return true;
    }
    if (force === false) {
      this.classes.delete(name);
      return false;
    }
    if (this.classes.has(name)) {
      this.classes.delete(name);
      return false;
    }
    this.classes.add(name);
    return true;
  }

  contains(name: string) {
    return this.classes.has(name);
  }
}

class FakeElement {
  value = '';
  textContent = '';
  innerHTML = '';
  hidden = false;
  checked = false;
  disabled = false;
  files?: Array<{ name: string }>;
  dataset: Record<string, string> = {};
  classList = new FakeClassList();
  listeners = new Map<string, (event?: Record<string, unknown>) => void | Promise<void>>();

  addEventListener(type: string, handler: (event?: Record<string, unknown>) => void | Promise<void>) {
    this.listeners.set(type, handler);
  }

  reset() {
    this.value = '';
    this.checked = false;
  }
}

function createMockFetch(responses: MockResponse[]) {
  return jest.fn(async (_url: string, _options?: Record<string, unknown>) => {
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
    'clerk-sign-in',
    'clerk-sign-out',
    'refresh',
    'auth-mode',
    'auth-feedback',
    'summary',
    'health-live',
    'health-ready',
    'overview-feedback',
    'entries-filter',
    'from',
    'to',
    'search',
    'page-size',
    'entries-meta',
    'entries-body',
    'entries-prev',
    'entries-next',
    'entries-page',
    'feed-create-form',
    'feed-url',
    'feed-poll-interval',
    'feed-status',
    'feeds-feedback',
    'feeds-filter',
    'feeds-filter-status',
    'feeds-filter-q',
    'feeds-page-size',
    'feeds-meta',
    'feeds-body',
    'feeds-prev',
    'feeds-next',
    'feeds-page',
    'rule-create-form',
    'rule-name',
    'rule-include',
    'rule-exclude',
    'rule-active',
    'rules-feedback',
    'rules-filter',
    'rules-page-size',
    'rules-meta',
    'rules-body',
    'rules-prev',
    'rules-next',
    'rules-page',
    'alerts-filter',
    'alerts-sent',
    'alerts-page-size',
    'alerts-feedback',
    'alerts-meta',
    'alerts-body',
    'alerts-prev',
    'alerts-next',
    'alerts-page',
    'opml-upload-form',
    'opml-file',
    'opml-feedback',
    'opml-preview-form',
    'opml-import-id',
    'opml-preview-page-size',
    'opml-preview-meta',
    'opml-preview-body',
    'opml-preview-prev',
    'opml-preview-next',
    'opml-preview-page',
    'opml-confirm',
    'opml-status-refresh',
    'opml-status-output',
    'settings-form',
    'settings-webhook-url',
    'settings-save',
    'settings-clear',
    'settings-refresh',
    'settings-feedback',
    'tab-btn-overview',
    'tab-btn-feeds',
    'tab-btn-rules-alerts',
    'tab-btn-entries',
    'tab-btn-opml',
    'tab-btn-settings',
    'tab-overview',
    'tab-feeds',
    'tab-rules-alerts',
    'tab-entries',
    'tab-opml',
    'tab-settings',
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
    FormData,
    Date,
    Promise,
    console,
  });

  const script = readFileSync(join(process.cwd(), 'public', 'dashboard', 'app.js'), 'utf8');
  vm.runInContext(script, context);

  return { elements, fetch, storage };
}

async function flush() {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

function fullRefreshResponses(): MockResponse[] {
  return [
    { body: { data: { feedsTotal: 10, feedsActive: 9, feedsError: 1, entries24h: 4, entries7d: 12, alertsPending: 2 } } },
    { body: { status: 'ok' } },
    { body: { status: 'ok' } },
    { body: { data: [], meta: { total: 0, page: 1, has_next: false } } },
    { body: { data: [], meta: { total: 0, page: 1, has_next: false } } },
    { body: { data: [], meta: { total: 0, page: 1, has_next: false } } },
    { body: { data: [], meta: { total: 0, page: 1, has_next: false } } },
  ];
}

describe('dashboard client', () => {
  it('prompts for API key before fetching', async () => {
    const harness = createHarness([]);
    const feedback = harness.elements.get('auth-feedback');
    if (!feedback) throw new Error('missing element');

    await flush();

    expect(harness.fetch).toHaveBeenCalledTimes(0);
    expect(feedback.textContent).toContain('API key');
  });

  it('saves API key and sends tenant auth headers', async () => {
    const harness = createHarness(fullRefreshResponses());

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
    expect(harness.fetch).toHaveBeenCalledTimes(7);

    const firstCall = harness.fetch.mock.calls[0];
    const options = firstCall?.[1] as { headers: Record<string, string> };
    expect(options.headers.Authorization).toBe('Bearer ak_test');
    expect(options.headers['x-api-key']).toBe('ak_test');
    expect(feedback.textContent).toContain('Datos actualizados');
  });

  it('creates a feed from dashboard form', async () => {
    const responses = [
      ...fullRefreshResponses(),
      { body: { data: { id: 123, status: 'active' } } },
      { body: { data: [{ id: 123, url: 'https://example.com/rss.xml', status: 'active', nextCheckAt: '2026-03-31T00:00:00.000Z' }], meta: { total: 1, page: 1, has_next: false } } },
      { body: { data: { feedsTotal: 11, feedsActive: 10, feedsError: 1, entries24h: 4, entries7d: 12, alertsPending: 2 } } },
      { body: { status: 'ok' } },
      { body: { status: 'ok' } },
    ];

    const harness = createHarness(responses);
    const apiKey = harness.elements.get('api-key');
    const saveKey = harness.elements.get('save-key');
    const createForm = harness.elements.get('feed-create-form');
    const feedUrl = harness.elements.get('feed-url');
    const poll = harness.elements.get('feed-poll-interval');
    const status = harness.elements.get('feed-status');
    if (!apiKey || !saveKey || !createForm || !feedUrl || !poll || !status) throw new Error('missing element');

    await flush();
    apiKey.value = 'ak_test';
    const click = saveKey.listeners.get('click');
    if (!click) throw new Error('click listener missing');
    await click();
    await flush();

    feedUrl.value = 'https://example.com/rss.xml';
    poll.value = '600';
    status.value = 'active';
    const submit = createForm.listeners.get('submit');
    if (!submit) throw new Error('submit listener missing');
    await submit({ preventDefault: () => undefined });
    await flush();

    const postCall = harness.fetch.mock.calls.find(
      (call) => call[0] === '/api/v1/feeds' && (call[1] as { method?: string })?.method === 'POST',
    );
    expect(postCall).toBeDefined();

    const postOptions = postCall?.[1] as { body: string; headers: Record<string, string> };
    expect(JSON.parse(postOptions.body)).toEqual({
      url: 'https://example.com/rss.xml',
      poll_interval_seconds: 600,
      status: 'active',
    });
    expect(postOptions.headers.Authorization).toBe('Bearer ak_test');
    expect(postOptions.headers['x-api-key']).toBe('ak_test');
  });

  it('loads and updates webhook settings from dashboard tab', async () => {
    const responses = [
      ...fullRefreshResponses(),
      { body: { data: { webhookNotifierUrl: 'https://hooks.example.com/old' } } },
      { body: { data: { webhookNotifierUrl: 'https://hooks.example.com/new' } } },
      { body: { data: { webhookNotifierUrl: 'https://hooks.example.com/new' } } },
    ];

    const harness = createHarness(responses);
    const apiKey = harness.elements.get('api-key');
    const saveKey = harness.elements.get('save-key');
    const settingsRefresh = harness.elements.get('settings-refresh');
    const settingsForm = harness.elements.get('settings-form');
    const settingsInput = harness.elements.get('settings-webhook-url');
    if (!apiKey || !saveKey || !settingsRefresh || !settingsForm || !settingsInput) throw new Error('missing element');

    await flush();
    apiKey.value = 'ak_test';
    const click = saveKey.listeners.get('click');
    if (!click) throw new Error('click listener missing');
    await click();
    await flush();

    const refreshClick = settingsRefresh.listeners.get('click');
    if (!refreshClick) throw new Error('settings refresh listener missing');
    await refreshClick();
    await flush();
    expect(settingsInput.value).toBe('https://hooks.example.com/old');

    settingsInput.value = 'https://hooks.example.com/new';
    const submit = settingsForm.listeners.get('submit');
    if (!submit) throw new Error('settings submit listener missing');
    await submit({ preventDefault: () => undefined });
    await flush();

    const putCall = harness.fetch.mock.calls.find(
      (call) => call[0] === '/api/v1/settings' && (call[1] as { method?: string })?.method === 'PUT',
    );
    expect(putCall).toBeDefined();

    const putOptions = putCall?.[1] as { body: string; headers: Record<string, string> };
    expect(JSON.parse(putOptions.body)).toEqual({ webhook_notifier_url: 'https://hooks.example.com/new' });
    expect(putOptions.headers.Authorization).toBe('Bearer ak_test');
  });
});
