import { AppConfigService } from '../src/shared/config/app-config.service';
import { AlertNotificationPayload } from '../src/modules/notifications/domain/alert-notifier.port';
import { WebhookAlertNotifier } from '../src/modules/notifications/infrastructure/webhook-alert.notifier';

describe('WebhookAlertNotifier.sendEmail', () => {
  const originalFetch = global.fetch;

  const alert: AlertNotificationPayload = {
    id: 'alert_1',
    tenantId: 'tenant_demo',
    createdAt: '2026-03-31T12:34:56.000Z',
    sent: false,
    sentAt: null,
    entry: {
      id: 'entry_1',
      title: 'Título de prueba',
      link: 'https://example.com/post-1',
      content: 'Entradilla breve de ejemplo para que el correo se entienda mejor.',
    },
    rule: {
      id: 10,
      name: 'Noticias de IA',
      includeKeywords: ['ia', 'llm'],
      excludeKeywords: ['rumor'],
    },
  };

  function buildNotifier(): WebhookAlertNotifier {
    const appConfigService = {
      resendApiKey: 're_test_x',
      resendFromEmail: 'alerts@example.com',
      webhookNotifierTimeoutMs: 1_000,
      webhookNotifierUrl: undefined,
    } as AppConfigService;

    return new WebhookAlertNotifier(appConfigService);
  }

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('envía asunto y cuerpo en español con versiones text/html', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 202 } as Response);

    const notifier = buildNotifier();
    await notifier.sendEmail(alert, ['dev@example.com']);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, options] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(options.body)) as {
      subject: string;
      text: string;
      html: string;
      to: string[];
    };

    expect(payload.to).toEqual(['dev@example.com']);
    expect(payload.subject).toContain('Nueva alerta: Título de prueba');
    expect(payload.text).toContain('Resumen');
    expect(payload.text).toContain('Título: Título de prueba');
    expect(payload.text).toContain('Entradilla: Entradilla breve de ejemplo para que el correo se entienda mejor.');
    expect(payload.text).toContain('Enlace: https://example.com/post-1');
    expect(payload.text).toContain('Regla: Noticias de IA');
    expect(payload.text).toContain('Palabras clave: ia, llm');
    expect(payload.html).toContain('<html lang="es">');
    expect(payload.html).toContain('Leer noticia');
    expect(payload.html).toContain('<strong>Palabras clave:</strong> ia, llm');
  });

  it('escapa contenido dinámico en html para evitar inyección de marcado', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 202 } as Response);

    const notifier = buildNotifier();
    await notifier.sendEmail(
      {
        ...alert,
        entry: {
          ...alert.entry,
          title: '<script>alert(1)</script>',
          link: 'https://evil.test/?q=<tag>&x="1"',
          content: 'Texto con <b>HTML</b> y <script>malo</script>',
        },
        rule: {
          ...alert.rule,
          name: 'Regla <b>peligrosa</b>',
          includeKeywords: ['ok', '<img src=x onerror=1>'],
          excludeKeywords: ['"drop"'],
        },
      },
      ['dev@example.com'],
    );

    const [, options] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(options.body)) as { html: string };

    expect(payload.html).not.toContain('<script>alert(1)</script>');
    expect(payload.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(payload.html).toContain('Texto con &lt;b&gt;HTML&lt;/b&gt; y &lt;script&gt;malo&lt;/script&gt;');
    expect(payload.html).toContain('Regla &lt;b&gt;peligrosa&lt;/b&gt;');
    expect(payload.html).toContain('&lt;img src=x onerror=1&gt;');
    expect(payload.html).toContain('href="https://evil.test/?q=&lt;tag&gt;&amp;x=&quot;1&quot;"');
  });

  it('recorta el asunto cuando el título es demasiado largo', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 202 } as Response);

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

    const [, options] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(options.body)) as { subject: string };

    expect(payload.subject.length).toBeLessThanOrEqual(120);
    expect(payload.subject.endsWith('…')).toBe(true);
  });
});
