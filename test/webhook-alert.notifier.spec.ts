import type { AlertNotificationPayload } from '../src/modules/notifications/domain/alert-notifier.port';
import { WebhookAlertNotifier } from '../src/modules/notifications/infrastructure/webhook-alert.notifier';
import type { AppConfigService } from '../src/shared/config/app-config.service';
import { UnsafeHostError, UnsafeProtocolError } from '../src/shared/http/url-safety';

describe('WebhookAlertNotifier', () => {
  const originalFetch = global.fetch;
  const originalAllowPrivate = process.env['ALLOW_PRIVATE_FEED_HOSTS'];

  const alert: AlertNotificationPayload = {
    id: 'alert_1',
    tenantId: 'tenant_demo',
    createdAt: '2026-03-31T12:34:56.000Z',
    sent: false,
    sentAt: null,
    entry: {
      id: 'entry_1',
      title: 'Test headline',
      link: 'https://example.com/post-1',
      content: 'Short excerpt so the email reads better.',
    },
    rule: {
      id: 10,
      name: 'AI news',
      includeKeywords: ['ia', 'llm'],
      excludeKeywords: ['rumour'],
    },
  };

  function buildNotifier(overrides: Partial<AppConfigService> = {}): WebhookAlertNotifier {
    const appConfigService = {
      resendApiKey: 're_test_x',
      resendFromEmail: 'alerts@example.com',
      webhookNotifierTimeoutMs: 1_000,
      webhookNotifierUrl: undefined,
      telegramBotToken: 'tg_test_token',
      telegramApiUrl: 'https://api.telegram.test',
      ...overrides,
    } as AppConfigService;

    return new WebhookAlertNotifier(appConfigService);
  }

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalAllowPrivate === undefined) {
      delete process.env['ALLOW_PRIVATE_FEED_HOSTS'];
    } else {
      process.env['ALLOW_PRIVATE_FEED_HOSTS'] = originalAllowPrivate;
    }
    jest.restoreAllMocks();
  });

  it('sends the subject and body in English with text/html versions', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 202 });

    const notifier = buildNotifier();
    await notifier.sendEmail(alert, ['dev@example.com']);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, options] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit & { body: string }];
    const payload = JSON.parse(options.body) as {
      subject: string;
      text: string;
      html: string;
      to: string[];
    };

    expect(payload.to).toEqual(['dev@example.com']);
    expect(payload.subject).toContain('New alert: Test headline');
    expect(payload.text).toContain('Summary');
    expect(payload.text).toContain('Title: Test headline');
    expect(payload.text).toContain('Excerpt: Short excerpt so the email reads better.');
    expect(payload.text).toContain('Link: https://example.com/post-1');
    expect(payload.text).toContain('Rule: AI news');
    expect(payload.text).toContain('Keywords: ia, llm');
    expect(payload.html).toContain('<html lang="en">');
    expect(payload.html).toContain('Read article');
    expect(payload.html).toContain('<strong>Keywords:</strong> ia, llm');
  });

  it('escapes dynamic content in html to prevent markup injection', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 202 });

    const notifier = buildNotifier();
    await notifier.sendEmail(
      {
        ...alert,
        entry: {
          ...alert.entry,
          title: '<script>alert(1)</script>',
          link: 'https://evil.test/?q=<tag>&x="1"',
          content: 'Text with <b>HTML</b> and <script>bad</script>',
        },
        rule: {
          ...alert.rule,
          name: 'Rule <b>dangerous</b>',
          includeKeywords: ['ok', '<img src=x onerror=1>'],
          excludeKeywords: ['"drop"'],
        },
      },
      ['dev@example.com'],
    );

    const [, options] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit & { body: string }];
    const payload = JSON.parse(options.body) as { html: string };

    expect(payload.html).not.toContain('<script>alert(1)</script>');
    expect(payload.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(payload.html).toContain('Text with &lt;b&gt;HTML&lt;/b&gt; and &lt;script&gt;bad&lt;/script&gt;');
    expect(payload.html).toContain('Rule &lt;b&gt;dangerous&lt;/b&gt;');
    expect(payload.html).toContain('&lt;img src=x onerror=1&gt;');
    expect(payload.html).toContain('href="https://evil.test/?q=&lt;tag&gt;&amp;x=&quot;1&quot;"');
  });

  it('truncates the subject when the title is too long', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 202 });

    const notifier = buildNotifier();
    await notifier.sendEmail(
      {
        ...alert,
        entry: {
          ...alert.entry,
          title: 'x'.repeat(300),
        },
      },
      ['dev@example.com'],
    );

    const [, options] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit & { body: string }];
    const payload = JSON.parse(options.body) as { subject: string };

    expect(payload.subject.length).toBeLessThanOrEqual(120);
    expect(payload.subject.endsWith('…')).toBe(true);
  });

  it('sends an instant Telegram alert in a compact format', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });

    const notifier = buildNotifier();
    await notifier.sendTelegram(alert, '-100200');

    const [url, options] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit & { body: string }];
    expect(url).toBe('https://api.telegram.test/bottg_test_token/sendMessage');
    const payload = JSON.parse(options.body) as { chat_id: string; text: string; parse_mode?: string };
    expect(payload.chat_id).toBe('-100200');
    expect(payload.parse_mode).toBeUndefined();
    expect(payload.text).toContain('New alert');
    expect(payload.text).toContain('https://example.com/post-1');
  });

  it('sends a grouped Telegram digest', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });

    const notifier = buildNotifier();
    await notifier.sendTelegramDigest({
      tenantId: 'tenant_demo',
      chatId: '-100200',
      windowLabel: 'Window until 31/03/2026, 12:40 UTC',
      items: [
        { title: 'Headline A', snippet: 'Summary A', link: 'https://example.com/a' },
        { title: 'Headline B', snippet: 'Summary B', link: 'https://example.com/b' },
      ],
    });

    const [, options] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit & { body: string }];
    const payload = JSON.parse(options.body) as { text: string };
    expect(payload.text).toContain('Alert digest (2)');
    expect(payload.text).toContain('Headline A');
    expect(payload.text).toContain('https://example.com/b');
  });

  it('uses the tenant token when it is passed as an override', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });

    const notifier = buildNotifier();
    await notifier.sendTelegram(alert, '-100200', 'tenant_token_override');

    const [url] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit & { body: string }];
    expect(url).toBe('https://api.telegram.test/bottenant_token_override/sendMessage');
  });

  it('throws telegram_notifier_disabled when neither tenant nor global token exists', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });

    const notifier = buildNotifier({ telegramBotToken: undefined });
    await expect(notifier.sendTelegram(alert, '-100200')).rejects.toThrow('telegram_notifier_disabled');
  });

  describe('sendWebhook', () => {
    it('posts the alert to a public destination', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

      await buildNotifier().sendWebhook(alert, 'https://hooks.example.com/alerts');

      const [url, options] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit & { body: string }];
      expect(url).toBe('https://hooks.example.com/alerts');
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body)).toEqual({ alert });
    });

    it('refuses to deliver to loopback or private destinations', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
      const notifier = buildNotifier();

      await expect(notifier.sendWebhook(alert, 'http://127.0.0.1:9000/hook')).rejects.toThrow(UnsafeHostError);
      await expect(notifier.sendWebhook(alert, 'http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
        'unsafe_host',
      );
      await expect(notifier.sendWebhook(alert, 'file:///etc/passwd')).rejects.toThrow(UnsafeProtocolError);

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('re-validates every redirect hop and blocks a 302 to cloud metadata', async () => {
      // REGRESSION GUARD. This sink used to validate the destination once and
      // then deliver with the global `fetch`, which follows redirects on its
      // own. A destination that passes the hostname check could answer
      // `302 Location: http://169.254.169.254/` and the alert JSON landed on
      // cloud metadata. The delivery now goes through `safeFetch`, which sets
      // `redirect: 'manual'` and re-runs the guard on every hop.
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 302,
        headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data/' }),
      });

      await expect(buildNotifier().sendWebhook(alert, 'https://hooks.example.com/alerts')).rejects.toThrow(
        'unsafe_host',
      );

      // The first hop is legitimately requested; what must never happen is a
      // second call carrying the alert body to the redirected internal target.
      expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
    });

    it('validates the configured fallback URL as well', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

      await expect(
        buildNotifier({ webhookNotifierUrl: 'http://10.0.0.9/hook' }).sendWebhook(alert, ''),
      ).rejects.toThrow('unsafe_host');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('allows private destinations when the escape hatch is enabled', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

      const notifier = buildNotifier({ allowPrivateFeedHosts: true });
      await notifier.sendWebhook(alert, 'http://127.0.0.1:9000/hook');

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('does nothing when no destination is configured', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

      await buildNotifier().sendWebhook(alert, '');

      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
