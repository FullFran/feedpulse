import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { applyRequestIdHeader } from '../interceptors/request-id.interceptor';

/** Public error envelope returned by every failing HTTP request. */
export interface ErrorEnvelope {
  statusCode: number;
  code: string;
  message: string;
  timestamp: string;
  path: string;
  requestId: string;
}

const SNAKE_CODE = /^[a-z][a-z0-9_]*$/;

const STATUS_CODES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'bad_request',
  [HttpStatus.UNAUTHORIZED]: 'unauthorized',
  [HttpStatus.FORBIDDEN]: 'forbidden',
  [HttpStatus.NOT_FOUND]: 'not_found',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'method_not_allowed',
  [HttpStatus.CONFLICT]: 'conflict',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'payload_too_large',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'unsupported_media_type',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'unprocessable_entity',
  [HttpStatus.TOO_MANY_REQUESTS]: 'too_many_requests',
  [HttpStatus.NOT_IMPLEMENTED]: 'not_implemented',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'service_unavailable',
};

const INTERNAL_ERROR_CODE = 'internal_server_error';
const INTERNAL_ERROR_MESSAGE = 'Internal server error';

// `HttpStatus` members carry the enum type, and the status codes compared
// against them here arrive as plain numbers off the wire. Widening the two
// bounds to `number` once keeps the names readable at the call sites without
// asking every comparison to mix an enum with a number.
const BAD_REQUEST_STATUS: number = HttpStatus.BAD_REQUEST;
const INTERNAL_SERVER_ERROR_STATUS: number = HttpStatus.INTERNAL_SERVER_ERROR;

/** Machine-readable codes are lower snake_case, e.g. `feed_not_found`. */
export function isSnakeCode(value: unknown): value is string {
  return typeof value === 'string' && SNAKE_CODE.test(value);
}

export function defaultCodeForStatus(statusCode: number): string {
  if (STATUS_CODES[statusCode]) {
    return STATUS_CODES[statusCode];
  }

  return statusCode >= INTERNAL_SERVER_ERROR_STATUS ? INTERNAL_ERROR_CODE : 'http_error';
}

/**
 * Extracts the stable machine-readable code from a Nest exception payload.
 * The codebase throws `new NotFoundException('feed_not_found')`, which Nest
 * expands into `{ statusCode, message: 'feed_not_found', error: 'Not Found' }`,
 * so a snake_case `message` is promoted to `code`.
 */
export function pickCode(payload: Record<string, unknown>, statusCode: number): string {
  if (typeof payload.code === 'string' && payload.code.length > 0) {
    return payload.code;
  }

  if (isSnakeCode(payload.message)) {
    return payload.message;
  }

  if (isSnakeCode(payload.error)) {
    return payload.error;
  }

  return defaultCodeForStatus(statusCode);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recognises the `http-errors` contract used by the Express middleware that runs
 * outside Nest's own exception classes — `body-parser` raising
 * `PayloadTooLargeError` (413) once a request exceeds the configured body limit,
 * `raw-body` raising a 400 on a malformed charset, and multer's limit errors.
 *
 * Those objects are not `HttpException`s, so without this they were flattened to
 * `500 internal_server_error`: a caller that sent an oversized body was told the
 * server broke. `expose === true` is the library's own marker that the status and
 * message are safe to return to the client, and it is only ever set for 4xx.
 */
function resolveExposedHttpError(exception: unknown): { status: number; message: string } | null {
  if (exception instanceof HttpException || !(exception instanceof Error)) {
    return null;
  }

  const candidate = exception as Error & { status?: unknown; statusCode?: unknown; expose?: unknown };
  if (candidate.expose !== true) {
    return null;
  }

  const status = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;
  if (typeof status !== 'number' || status < BAD_REQUEST_STATUS || status >= INTERNAL_SERVER_ERROR_STATUS) {
    return null;
  }

  return { status, message: exception.message };
}

/**
 * Single global exception filter.
 *
 * Guarantees for every failing HTTP request:
 * - the response is JSON, never Express' HTML error page;
 * - the body carries a stable `code` alongside the human `message`;
 * - internal class names and stack traces stay server-side.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      this.logger.error(this.describe(exception), this.stackOf(exception));
      return;
    }

    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();

    const exposedHttpError = resolveExposedHttpError(exception);
    const statusCode =
      exception instanceof HttpException
        ? exception.getStatus()
        : (exposedHttpError?.status ?? HttpStatus.INTERNAL_SERVER_ERROR);
    const requestId = applyRequestIdHeader(request, response);
    const path = request?.originalUrl ?? request?.url ?? '';

    this.log(exception, statusCode, { method: request?.method, path, requestId });

    if (response.headersSent) {
      return;
    }

    const legacyPayload = this.legacyPayload(exception);
    if (legacyPayload) {
      // Endpoints such as `/ready` answer with their own documented payload;
      // rewriting it here would be a silent breaking change for consumers.
      response.status(statusCode).json(legacyPayload);
      return;
    }

    const envelope: ErrorEnvelope = {
      statusCode,
      ...this.describeForClient(exception, statusCode),
      timestamp: new Date().toISOString(),
      path,
      requestId,
    };

    response.status(statusCode).json(envelope);
  }

  /**
   * Custom `HttpException` payloads (objects without a `message` field) are kept
   * verbatim for backwards compatibility.
   */
  private legacyPayload(exception: unknown): Record<string, unknown> | null {
    if (!(exception instanceof HttpException)) {
      return null;
    }

    const raw = exception.getResponse();
    if (isPlainObject(raw) && !('message' in raw)) {
      return raw;
    }

    return null;
  }

  private describeForClient(exception: unknown, statusCode: number): { code: string; message: string } {
    if (!(exception instanceof HttpException)) {
      const exposed = resolveExposedHttpError(exception);
      if (exposed) {
        return { code: defaultCodeForStatus(exposed.status), message: exposed.message };
      }

      // Unknown failures never echo internal details back to the caller.
      return { code: INTERNAL_ERROR_CODE, message: INTERNAL_ERROR_MESSAGE };
    }

    const raw = exception.getResponse();

    if (typeof raw === 'string') {
      return { code: isSnakeCode(raw) ? raw : defaultCodeForStatus(statusCode), message: raw };
    }

    if (isPlainObject(raw)) {
      if (Array.isArray(raw.message)) {
        // `ValidationPipe` reports one entry per failed constraint; the DTOs
        // declare snake_case constraint messages such as `feed_invalid_url`, so
        // a single failure keeps its own code.
        const entries = raw.message.filter((entry): entry is string => typeof entry === 'string');
        const message = entries.join('; ');
        const code =
          typeof raw.code === 'string' && raw.code.length > 0
            ? raw.code
            : entries.length === 1 && isSnakeCode(entries[0])
              ? entries[0]
              : 'validation_failed';

        return { code, message: message.length > 0 ? message : 'validation_failed' };
      }

      const message = typeof raw.message === 'string' ? raw.message : exception.message;
      return { code: pickCode(raw, statusCode), message };
    }

    return { code: defaultCodeForStatus(statusCode), message: exception.message };
  }

  private log(
    exception: unknown,
    statusCode: number,
    context: { method?: string; path: string; requestId: string },
  ): void {
    const summary = `${context.method ?? 'UNKNOWN'} ${context.path} failed with ${statusCode} [requestId=${context.requestId}]`;

    if (statusCode >= INTERNAL_SERVER_ERROR_STATUS) {
      this.logger.error(`${summary}: ${this.describe(exception)}`, this.stackOf(exception));
      return;
    }

    this.logger.warn(`${summary}: ${this.describe(exception)}`);
  }

  private describe(exception: unknown): string {
    if (exception instanceof Error) {
      return `${exception.constructor.name}: ${exception.message}`;
    }

    return String(exception);
  }

  private stackOf(exception: unknown): string | undefined {
    return exception instanceof Error ? exception.stack : undefined;
  }
}
