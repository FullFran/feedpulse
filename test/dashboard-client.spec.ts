import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

type MockResponseBody = Record<string, unknown> | string;

type MockResponse = {
  body: MockResponseBody;
  contentType?: string;
  ok?: boolean;
  status?: number;
  statusText?: string;
};

class FakeElement {
  id: string;
  textContent = '';
  className = '';
  innerHTML = '';
  value = '';
  children: FakeElement[] = [];
  readonly listeners = new Map<string, (event: Record<string, unknown>) => Promise<void> | void>();
  readonly attributes = new Map<string, string>();
  resetCalled = false;
  fields: Record<string, unknown> = {};

  constructor(id = '') {
    this.id = id;
  }

  addEventListener(type: string, handler: (event: Record<string, unknown>) => Promise<void> | void): void {
    this.listeners.set(type, handler);
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  querySelector(selector: string): FakeElement {
    const existing = this.children.find((child) => child.attributes.get('selector') === selector);
    if (existing) {
      return existing;
    }

    const child = new FakeElement();
    child.attributes.set('selector', selector);
    this.children.push(child);
    return child;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  cloneNode(): FakeElement {
    return new FakeElement();
  }

  reset(): void {
    this.resetCalled = true;
  }
}

class FakeTemplateElement extends FakeElement {
  content = {
    firstElementChild: {
      cloneNode: () => new FakeElement(),
    },
  };
}

class FakeFormData {
  constructor(private readonly form: FakeElement) {}

  get(name: string): unknown {
    return this.form.fields[name] ?? null;
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

function createDashboardHarness(responses: MockResponse[]) {
  const elements = new Map<string, FakeElement>([
    ['summary-cards', new FakeElement('summary-cards')],
    ['summary-card-template', new FakeTemplateElement('summary-card-template')],
    ['feeds-list', new FakeElement('feeds-list')],
    ['rules-list', new FakeElement('rules-list')],
    ['entries-list', new FakeElement('entries-list')],
    ['alerts-list', new FakeElement('alerts-list')],
    ['refresh-all', new FakeElement('refresh-all')],
    ['feed-form', new FakeElement('feed-form')],
    ['feed-feedback', new FakeElement('feed-feedback')],
    ['rule-form', new FakeElement('rule-form')],
    ['rule-feedback', new FakeElement('rule-feedback')],
  ]);

  const fetch = createMockFetch(responses);
  const body = new FakeElement('body');

  const context = vm.createContext({
    console,
    fetch,
    FormData: FakeFormData,
    document: {
      body,
      createElement: () => new FakeElement(),
      getElementById: (id: string) => {
        const element = elements.get(id);
        if (!element) {
          throw new Error(`Unknown element ${id}`);
        }

        return element;
      },
    },
    window: {
      alert: jest.fn(),
    },
    HTMLElement: FakeElement,
    setTimeout,
    clearTimeout,
    Promise,
  });

  const script = readFileSync(join(process.cwd(), 'public', 'dashboard', 'app.js'), 'utf8');
  vm.runInContext(script, context);

  return {
    body,
    elements,
    fetch,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function successfulRefreshResponses(): MockResponse[] {
  return [
    { body: { status: 'ok', checks: { api: 'up' } } },
    { body: { status: 'ready', checks: { database: 'up', redis: 'up' } } },
    { body: { data: [] } },
    { body: { data: [] } },
    { body: { data: [] } },
    { body: { data: [] } },
  ];
}

describe('dashboard client', () => {
  it('keeps feed creation successful when the follow-up refresh fails', async () => {
    const harness = createDashboardHarness([
      ...successfulRefreshResponses(),
      { body: { data: { id: 42 } } },
      { ok: false, status: 503, statusText: 'Service Unavailable', body: { message: ['gateway_timeout'], error: 'Service Unavailable', statusCode: 503 } },
      { body: { status: 'ready', checks: { database: 'up', redis: 'up' } } },
      { body: { data: [] } },
      { body: { data: [] } },
      { body: { data: [] } },
      { body: { data: [] } },
    ]);

    await flushPromises();

    const feedForm = harness.elements.get('feed-form');
    if (!feedForm) {
      throw new Error('feed-form missing');
    }

    feedForm.fields = {
      url: 'https://example.com/runtime.xml',
      poll_interval_seconds: '300',
      status: 'active',
    };

    const submit = feedForm.listeners.get('submit');
    if (!submit) {
      throw new Error('submit listener missing');
    }

    await submit({
      preventDefault() {
        return undefined;
      },
      currentTarget: feedForm,
    });
    await flushPromises();

    const feedback = harness.elements.get('feed-feedback');
    expect(feedback?.textContent).toBe('Feed created. Dashboard refresh failed: gateway_timeout');
    expect(feedback?.className).toBe('feedback success');
    expect(feedForm.resetCalled).toBe(true);
  });

  it('surfaces envelope API errors instead of request_failed', async () => {
    const harness = createDashboardHarness([
      ...successfulRefreshResponses(),
      { ok: false, status: 409, statusText: 'Conflict', body: { error: { code: 'feed_conflict', message: 'feed_already_exists' } } },
    ]);

    await flushPromises();

    const feedForm = harness.elements.get('feed-form');
    if (!feedForm) {
      throw new Error('feed-form missing');
    }

    feedForm.fields = {
      url: 'https://example.com/runtime.xml',
      poll_interval_seconds: '300',
      status: 'active',
    };

    const submit = feedForm.listeners.get('submit');
    if (!submit) {
      throw new Error('submit listener missing');
    }

    await submit({
      preventDefault() {
        return undefined;
      },
      currentTarget: feedForm,
    });
    await flushPromises();

    const feedback = harness.elements.get('feed-feedback');
    expect(feedback?.textContent).toBe('feed_already_exists');
    expect(feedback?.className).toBe('feedback error');
  });
});
