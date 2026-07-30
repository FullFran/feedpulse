import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable } from 'rxjs';

export const REQUEST_ID_HEADER = 'x-request-id';

interface RequestWithId {
  /** `pino-http` types its request id as `string | number | object`. */
  id?: string | number | object;
  headers?: Record<string, string | string[] | undefined>;
}

interface ResponseWithHeader {
  setHeader?: (name: string, value: string) => unknown;
  headersSent?: boolean;
}

/**
 * Returns the correlation id for a request, honouring the inbound
 * `x-request-id` header and the id `pino-http` already assigned. The resolved
 * value is cached back on the request so the interceptor, the exception filter
 * and the response body always agree.
 */
export function resolveRequestId(request: RequestWithId | undefined): string {
  if (!request) {
    return randomUUID();
  }

  if (typeof request.id === 'string' && request.id.length > 0) {
    return request.id;
  }

  if (typeof request.id === 'number') {
    return String(request.id);
  }

  const header = request.headers?.[REQUEST_ID_HEADER];
  const inbound = Array.isArray(header) ? header[0] : header;
  const requestId = typeof inbound === 'string' && inbound.trim().length > 0 ? inbound.trim() : randomUUID();

  request.id = requestId;
  return requestId;
}

/** Copies the correlation id onto the response so callers can quote it in bug reports. */
export function applyRequestIdHeader(
  request: RequestWithId | undefined,
  response: ResponseWithHeader | undefined,
): string {
  const requestId = resolveRequestId(request);

  if (response?.setHeader && response.headersSent !== true) {
    response.setHeader(REQUEST_ID_HEADER, requestId);
  }

  return requestId;
}

@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();

    // Applied before the handler runs so the header is present on error
    // responses too, where the success path of the stream never emits.
    applyRequestIdHeader(http.getRequest<RequestWithId>(), http.getResponse<ResponseWithHeader>());

    return next.handle();
  }
}
