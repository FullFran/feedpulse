import type { Response } from 'supertest';
import type { ErrorEnvelope } from '../../src/shared/filters/all-exceptions.filter';
import type { ApiMeta, PaginatedMeta } from '../../src/shared/http/response';

/**
 * Typed readers for supertest response bodies.
 *
 * supertest types `Response.body` as `any`, so a plain
 * `expect(res.body.data[0].title)` is three `no-unsafe-*` findings and, more
 * importantly, is not checked against anything: renaming a field in the API
 * leaves the assertion compiling and silently passing on `undefined`.
 *
 * These helpers funnel that `any` through `unknown` in ONE audited place and
 * hand back the real production envelope types (`ApiMeta`, `PaginatedMeta`,
 * `ErrorEnvelope` are imported from `src/`, not re-declared), so a change to
 * the envelope shape breaks the compile instead of the assertions.
 *
 * The caller still supplies the payload type — that assertion is unavoidable
 * without running the response through a validator, but it is now explicit and
 * local rather than an implicit `any` spreading through the whole expression.
 *
 * Prefer these in new HTTP assertions:
 *
 *   const feed = dataOf<{ id: string; url: string }>(response);
 *   expect(feed.url).toBe('https://example.com/rss.xml');
 *
 *   const { meta } = paginatedBody<{ id: string }>(response);
 *   expect(meta.total).toBe(3);
 *
 *   expect(errorBody(response).code).toBe('rate_limit_exceeded');
 */

/** Envelope returned by `successResponse` in `src/shared/http/response.ts`. */
export interface ApiSuccessBody<TData> {
  data: TData;
  meta: ApiMeta;
}

/** Envelope returned by `paginatedResponse` in `src/shared/http/response.ts`. */
export interface ApiPaginatedBody<TItem> {
  data: TItem[];
  meta: PaginatedMeta;
}

/** Narrows supertest's `any` body to `unknown` exactly once. */
function bodyOf(response: Response): unknown {
  return response.body;
}

/** Reads a single-resource `{ data, meta }` envelope. */
export function successBody<TData>(response: Response): ApiSuccessBody<TData> {
  return bodyOf(response) as ApiSuccessBody<TData>;
}

/** Reads just the `data` of a single-resource envelope — the common case. */
export function dataOf<TData>(response: Response): TData {
  return successBody<TData>(response).data;
}

/** Reads a list `{ data: [], meta: { page, total, ... } }` envelope. */
export function paginatedBody<TItem>(response: Response): ApiPaginatedBody<TItem> {
  return bodyOf(response) as ApiPaginatedBody<TItem>;
}

/** Reads just the `data` array of a list envelope. */
export function itemsOf<TItem>(response: Response): TItem[] {
  return paginatedBody<TItem>(response).data;
}

/** Reads the error envelope produced by `AllExceptionsFilter`. */
export function errorBody(response: Response): ErrorEnvelope {
  return bodyOf(response) as ErrorEnvelope;
}
