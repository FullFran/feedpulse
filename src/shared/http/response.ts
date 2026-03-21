import { randomUUID } from 'node:crypto';

import { Request } from 'express';

export interface ApiMeta {
  timestamp: string;
  request_id: string;
}

export interface PaginatedMeta extends ApiMeta {
  page: number;
  page_size: number;
  total: number;
  has_next: boolean;
}

export function getRequestId(request: Request): string {
  const incoming = request.header('x-request-id');
  return incoming ?? randomUUID();
}

export function successResponse<T>(request: Request, data: T): { data: T; meta: ApiMeta } {
  return {
    data,
    meta: {
      timestamp: new Date().toISOString(),
      request_id: getRequestId(request),
    },
  };
}

export function paginatedResponse<T>(
  request: Request,
  data: T[],
  page: number,
  pageSize: number,
  total: number,
): { data: T[]; meta: PaginatedMeta } {
  return {
    data,
    meta: {
      page,
      page_size: pageSize,
      total,
      has_next: page * pageSize < total,
      timestamp: new Date().toISOString(),
      request_id: getRequestId(request),
    },
  };
}
