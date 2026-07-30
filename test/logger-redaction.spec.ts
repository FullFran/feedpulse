import type { IncomingMessage } from 'node:http';
import { Writable } from 'node:stream';
import pino from 'pino';
import { LOG_REDACTION_CENSOR, buildPinoHttpOptions, generateRequestId } from '../src/shared/logging/logger.module';
import { expectDefined } from './support/expect-defined';

interface LoggerOptions {
  level?: string;
  redact?: unknown;
  serializers?: Record<string, (input: never) => unknown>;
  transport?: unknown;
  genReqId?: (request: IncomingMessage) => string;
  autoLogging?: boolean;
}

function pinoOptions(pretty = false): LoggerOptions {
  return buildPinoHttpOptions({ level: 'info', pretty }) as LoggerOptions;
}

/** Collects raw NDJSON lines emitted by pino so redaction can be asserted on the wire format. */
function createCapturingLogger(): { logger: pino.Logger; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });

  const options = pinoOptions();
  const logger = pino({ level: 'info', redact: options.redact as pino.LoggerOptions['redact'] }, stream);

  return {
    logger,
    lines: () => chunks.join('').split('\n').filter(Boolean),
  };
}

describe('logger redaction', () => {
  it('censors credential headers and credential body fields', () => {
    const { logger, lines } = createCapturingLogger();

    logger.info(
      {
        req: {
          headers: {
            authorization: 'Bearer super-secret-jwt',
            cookie: '__session=super-secret-cookie',
            'x-api-key': 'super-secret-api-key',
            'user-agent': 'jest',
          },
          body: {
            password: 'super-secret-password',
            token: 'super-secret-token',
            secret: 'super-secret-secret',
            telegram_bot_token: '123456:super-secret-telegram-token',
            webhook_notifier_url: 'https://hooks.example.com/rss',
          },
        },
      },
      'request completed',
    );

    const [line] = lines();
    const payload = JSON.parse(expectDefined(line)) as {
      req: { headers: Record<string, string>; body: Record<string, string> };
    };

    expect(payload.req.headers.authorization).toBe(LOG_REDACTION_CENSOR);
    expect(payload.req.headers.cookie).toBe(LOG_REDACTION_CENSOR);
    expect(payload.req.headers['x-api-key']).toBe(LOG_REDACTION_CENSOR);
    expect(payload.req.body.password).toBe(LOG_REDACTION_CENSOR);
    expect(payload.req.body.token).toBe(LOG_REDACTION_CENSOR);
    expect(payload.req.body.secret).toBe(LOG_REDACTION_CENSOR);
    expect(payload.req.body.telegram_bot_token).toBe(LOG_REDACTION_CENSOR);

    expect(line).not.toContain('super-secret');

    // Non-credential fields stay readable, otherwise the logs are useless.
    expect(payload.req.headers['user-agent']).toBe('jest');
    expect(payload.req.body.webhook_notifier_url).toBe('https://hooks.example.com/rss');
  });

  it('keeps only non-sensitive fields in the serialized request', () => {
    const serializeRequest = pinoOptions().serializers?.req as unknown as (request: unknown) => Record<string, unknown>;

    const serialized = serializeRequest({
      id: 'req-1',
      method: 'PUT',
      url: '/api/v1/settings',
      remoteAddress: '127.0.0.1',
      headers: { authorization: 'Bearer super-secret-jwt' },
      body: { telegram_bot_token: '123456:super-secret-telegram-token' },
    });

    expect(serialized).toEqual({ id: 'req-1', method: 'PUT', url: '/api/v1/settings', remoteAddress: '127.0.0.1' });
    expect(JSON.stringify(serialized)).not.toContain('super-secret');
  });

  it('keeps only the status code in the serialized response', () => {
    const serializeResponse = pinoOptions().serializers?.res as unknown as (
      response: unknown,
    ) => Record<string, unknown>;

    expect(serializeResponse({ statusCode: 204, headers: { 'set-cookie': '__session=secret' } })).toEqual({
      statusCode: 204,
    });
  });
});

describe('request id generation', () => {
  function incoming(headers: Record<string, string | string[] | undefined>): IncomingMessage {
    return { headers } as unknown as IncomingMessage;
  }

  it('honours an inbound x-request-id header', () => {
    expect(generateRequestId(incoming({ 'x-request-id': 'inbound-trace-id' }))).toBe('inbound-trace-id');
  });

  it('takes the first value when the header is repeated', () => {
    expect(generateRequestId(incoming({ 'x-request-id': ['first-id', 'second-id'] }))).toBe('first-id');
  });

  it('falls back to a generated uuid when the header is missing or blank', () => {
    const generated = generateRequestId(incoming({}));
    expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    expect(generateRequestId(incoming({ 'x-request-id': '   ' }))).not.toBe('   ');
  });
});

describe('pino transport gating', () => {
  it('uses the pretty transport only when explicitly requested', () => {
    expect(pinoOptions(false).transport).toBeUndefined();
    expect(pinoOptions(true).transport).toEqual({
      target: 'pino-pretty',
      options: { colorize: true, singleLine: true },
    });
  });
});
