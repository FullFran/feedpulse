import type { UrlSafetyOptions } from './url-safety';
import { assertSafePublicUrl } from './url-safety';

/**
 * SSRF-aware wrapper around the global `fetch`.
 *
 * Validating the URL once and then letting `fetch` follow redirects on its own
 * is a bypass: a public origin can answer `302 Location: http://169.254.169.254/`
 * and the request lands on cloud metadata without ever being re-validated.
 * `safeFetch` therefore uses `redirect: 'manual'`, resolves every `Location`
 * against the current hop and re-runs {@link assertSafePublicUrl} before the
 * next request is issued.
 *
 * DNS rebinding is NOT mitigated here — see the note in `url-safety.ts`.
 */

/** Real news sites rarely chain more than 2-3 hops; 5 bounds the work. */
const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;
/** Enough to cover `<?xml version="1.0" encoding="ISO-8859-1"?>` plus a BOM. */
const XML_DECLARATION_SNIFF_BYTES = 200;

export class TooManyRedirectsError extends Error {
  constructor(readonly maxRedirects: number) {
    super('too_many_redirects');
    this.name = 'TooManyRedirectsError';
  }
}

export class InvalidRedirectError extends Error {
  constructor(readonly location: string | null) {
    super('invalid_redirect_location');
    this.name = 'InvalidRedirectError';
  }
}

export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super('feed_body_too_large');
    this.name = 'BodyTooLargeError';
  }
}

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface SafeFetchOptions extends UrlSafetyOptions {
  /** Maximum redirect hops followed. Defaults to 5. */
  maxRedirects?: number;
  /** Seam for tests; defaults to the global `fetch` resolved at call time. */
  fetchImpl?: FetchImpl;
}

export interface SafeFetchResult {
  response: Response;
  /** URL that produced the final (non-redirect) response. */
  finalUrl: string;
  redirectCount: number;
}

export async function safeFetch(
  url: string,
  init: RequestInit = {},
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const safetyOptions: UrlSafetyOptions = { allowPrivateHosts: options.allowPrivateHosts };

  let currentUrl = assertSafePublicUrl(url, safetyOptions);
  let currentInit: RequestInit = { ...init, redirect: 'manual' };

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // CodeQL reports `js/request-forgery` here. It is a false positive on the
    // SSRF guard itself: `currentUrl` is only ever assigned from
    // `assertSafePublicUrl`, above for the first hop and below for every
    // redirect target, so the value reaching `fetchImpl` has always been
    // validated. CodeQL cannot model a project-defined sanitizer without a
    // custom query pack, so it treats the URL as still tainted.
    const response = await fetchImpl(currentUrl.toString(), currentInit);

    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, finalUrl: currentUrl.toString(), redirectCount: hop };
    }

    // Drain the redirect body so the socket can be reused / released.
    await response.body?.cancel().catch(() => undefined);

    const location = response.headers.get('location');
    if (!location || !location.trim()) {
      throw new InvalidRedirectError(location);
    }

    let target: URL;
    try {
      target = new URL(location, currentUrl);
    } catch {
      throw new InvalidRedirectError(location);
    }

    // Re-validate protocol AND host of every hop before it is requested.
    currentUrl = assertSafePublicUrl(target, safetyOptions);
    currentInit = downgradeAfterRedirect(currentInit, response.status);
  }

  throw new TooManyRedirectsError(maxRedirects);
}

/**
 * Reads a response body with a hard byte cap.
 *
 * The `content-length` header short-circuits before a single byte is read, but
 * origins omit or understate it, so the stream is also counted as it arrives
 * and aborted the moment the cap is crossed.
 *
 * Charset resolution prefers utf-8: the bytes are decoded as utf-8 first and
 * only when that produces replacement characters is a declared legacy charset
 * honoured (HTTP `content-type`, else the `<?xml ... encoding="..."?>`
 * declaration sniffed from the first bytes).
 *
 * @param charsetHint charset label overriding the response `content-type`.
 */
export async function readBodyWithLimit(
  response: Response,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
  charsetHint?: string | null,
): Promise<string> {
  assertContentLengthWithinBudget(response, maxBytes);

  const buffer = await readBodyBytes(response, maxBytes);
  const declaredCharset =
    charsetHint ?? extractCharset(response.headers.get('content-type')) ?? sniffXmlDeclarationCharset(buffer);

  return decodeBody(buffer, declaredCharset);
}

/**
 * Reads `FEED_FETCH_MAX_BYTES` from the injected configuration when it exposes
 * `feedFetchMaxBytes`, falling back to the raw environment and then to 5 MiB.
 */
export function resolveFeedFetchMaxBytes(config?: object | null): number {
  const configured = (config as { feedFetchMaxBytes?: unknown } | null | undefined)?.feedFetchMaxBytes;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  const fromEnv = Number.parseInt(process.env['FEED_FETCH_MAX_BYTES'] ?? '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_MAX_BODY_BYTES;
}

/**
 * A 303 always becomes a GET, and browsers (plus every HTTP client in
 * practice) also downgrade POST to GET on 301/302. 307/308 preserve method and
 * body by definition.
 */
function downgradeAfterRedirect(init: RequestInit, status: number): RequestInit {
  const method = (init.method ?? 'GET').toUpperCase();
  const downgrades = status === 303 || ((status === 301 || status === 302) && method === 'POST');

  if (!downgrades) {
    return init;
  }

  const { body: _body, ...rest } = init;
  return { ...rest, method: 'GET' };
}

function assertContentLengthWithinBudget(response: Response, maxBytes: number): void {
  const headerValue = response.headers.get('content-length');
  if (!headerValue) {
    return;
  }

  const declared = Number.parseInt(headerValue, 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BodyTooLargeError(maxBytes);
  }
}

async function readBodyBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader?.();

  if (!reader) {
    // No stream (304, or a test double built from a plain object).
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new BodyTooLargeError(maxBytes);
    }
    return buffer;
  }

  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }

    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }

  return concat(chunks, received);
}

function concat(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const buffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

function decodeBody(buffer: Uint8Array, declaredCharset: string | null): string {
  const asUtf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer);

  const hasReplacementChars = asUtf8.includes('�');

  if (!hasReplacementChars || !declaredCharset || /^utf-?8$/i.test(declaredCharset)) {
    return asUtf8;
  }

  try {
    return new TextDecoder(declaredCharset, { fatal: false }).decode(buffer);
  } catch {
    // Unknown charset label — keep the lossy utf-8 decode rather than failing.
    return asUtf8;
  }
}

function extractCharset(contentType: string | null): string | null {
  if (!contentType) {
    return null;
  }

  const match = contentType.match(/charset\s*=\s*"?([^";]+)"?/i);
  return match?.[1]?.trim() ?? null;
}

function sniffXmlDeclarationCharset(buffer: Uint8Array): string | null {
  const head = new TextDecoder('latin1', { fatal: false }).decode(buffer.subarray(0, XML_DECLARATION_SNIFF_BYTES));
  const match = head.match(/<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i);
  return match?.[1]?.trim() ?? null;
}
