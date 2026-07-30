import { Global, Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule, Params } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { IncomingMessage } from 'node:http';
import { AppConfigModule } from '../config/app-config.module';
import { AppConfigService } from '../config/app-config.service';
import { REQUEST_ID_HEADER } from '../interceptors/request-id.interceptor';

/**
 * Header and body paths that must never reach an aggregated log. Pino only
 * redacts declared paths, so anything hand-interpolated into a log message
 * bypasses this list entirely: log identifiers, never raw credentials.
 */
export const LOG_REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.body.password',
  'req.body.token',
  'req.body.secret',
  // `PUT /api/v1/settings` accepts a raw Telegram bot token in the request body.
  'req.body.telegram_bot_token',
] as const;

export const LOG_REDACTION_CENSOR = '[REDACTED]';

interface SerializableRequest {
  id?: string | number;
  method?: string;
  url?: string;
  remoteAddress?: string;
}

interface SerializableResponse {
  statusCode?: number;
}

/**
 * Resolves the request id from the inbound `x-request-id` header so a trace
 * started by an upstream proxy survives across services, falling back to a
 * freshly generated UUID.
 */
export function generateRequestId(request: IncomingMessage): string {
  const header = request.headers?.[REQUEST_ID_HEADER];
  const value = Array.isArray(header) ? header[0] : header;

  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  return randomUUID();
}

/**
 * Builds the `pino-http` options shared by every runtime.
 *
 * `pretty` is intentionally opt-in: the pretty transport spawns a worker thread,
 * which is undesirable in production (aggregators parse JSON) and in tests (a
 * live worker thread keeps the Jest process alive).
 */
export function buildPinoHttpOptions(options: { level: string; pretty: boolean }): Params['pinoHttp'] {
  return {
    level: options.level,
    transport: options.pretty ? { target: 'pino-pretty', options: { colorize: true, singleLine: true } } : undefined,
    genReqId: generateRequestId,
    redact: {
      paths: [...LOG_REDACTED_PATHS],
      censor: LOG_REDACTION_CENSOR,
    },
    serializers: {
      req: (request: SerializableRequest) => ({
        id: request.id,
        method: request.method,
        url: request.url,
        remoteAddress: request.remoteAddress,
      }),
      res: (response: SerializableResponse) => ({
        statusCode: response.statusCode,
      }),
    },
    autoLogging: true,
  };
}

@Global()
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (appConfigService: AppConfigService): Params => ({
        pinoHttp: buildPinoHttpOptions({
          level: appConfigService.logLevel,
          pretty: appConfigService.nodeEnv === 'development',
        }),
      }),
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
