import { Inject, Injectable, Logger } from '@nestjs/common';
import Parser from 'rss-parser';
import { AppConfigService } from '../../../shared/config/app-config.service';
import {
  BodyTooLargeError,
  InvalidRedirectError,
  TooManyRedirectsError,
  readBodyWithLimit,
  resolveFeedFetchMaxBytes,
  safeFetch,
} from '../../../shared/http/safe-fetch';
import {
  UnsafeHostError,
  UnsafeProtocolError,
  assertSafePublicUrl,
  resolveAllowPrivateFeedHosts,
} from '../../../shared/http/url-safety';

/**
 * Closed vocabulary returned to the client.
 *
 * This endpoint hands an authenticated caller a general-purpose "fetch this URL
 * and tell me what happened" primitive, complete with timing. Raw error text
 * from `undici` leaks resolver detail, certificate subjects and occasionally
 * filesystem paths, so nothing derived from an upstream message ever reaches the
 * response body: every failure collapses into one of these labels.
 *
 * `http_${number}` carries the status only — never the upstream body.
 */
export type ValidateFeedUrlErrorCode =
  | 'dns_failure'
  | 'connection_refused'
  | 'tls_error'
  | 'timeout'
  | 'unsafe_protocol'
  | 'unsafe_host'
  | 'too_many_redirects'
  | 'invalid_redirect'
  | 'response_too_large'
  | 'parse_error'
  | `http_${number}`
  | 'unknown';

export interface ValidatedFeedSampleItem {
  title: string | null;
  link: string | null;
  publishedAt: string | null;
}

export interface ValidateFeedUrlResult {
  /** True when the origin answered with a status below 400 after redirects. */
  reachable: boolean;
  statusCode: number | null;
  latencyMs: number;
  feedTitle: string | null;
  itemCount: number | null;
  latestItemPublishedAt: string | null;
  sampleItems: ValidatedFeedSampleItem[];
  error: ValidateFeedUrlErrorCode | null;
}

/** Enough for the caller to recognise the feed, not enough to be an echo channel. */
const MAX_ECHOED_TEXT_LENGTH = 300;
/** Three items is what makes the result useful without turning it into a reader. */
const SAMPLE_ITEM_COUNT = 3;
/**
 * The probe runs inside a synchronous HTTP request, so it may not inherit the
 * worker's generous fetch timeout. Clamped to keep a slow origin from pinning a
 * request handler and to keep the timing signal coarse.
 */
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 10_000;

const VALIDATION_HEADERS: Record<string, string> = {
  'user-agent': 'RSSMonitor/1.0 (+https://github.com/hagalink/rss-monitor)',
  accept: 'application/rss+xml, application/xml, text/xml, application/atom+xml, */*',
};

/**
 * Probes an arbitrary URL and reports what a feed reader would find there,
 * before the caller commits to registering it.
 *
 * The outbound request goes through {@link safeFetch} rather than the global
 * `fetch`, which is what applies the SSRF guard to every redirect hop, and
 * through {@link readBodyWithLimit}, which applies `FEED_FETCH_MAX_BYTES`.
 *
 * It deliberately does NOT go through `HttpFeedFetcher`: `FeedsModule` cannot
 * import `IngestionModule` (that module already imports `FeedsModule`, so the
 * dependency would be circular), and `DomainRateLimiter.waitForSlot` blocks for
 * as long as the worker's per-domain backoff lasts — acceptable in a queue
 * worker, not in a request handler. Inbound abuse is bounded by the named
 * throttler on the route instead.
 */
@Injectable()
export class ValidateFeedUrlUseCase {
  private readonly logger = new Logger(ValidateFeedUrlUseCase.name);
  private readonly parser = new Parser<Record<string, unknown>, Record<string, unknown>>();

  constructor(@Inject(AppConfigService) private readonly appConfigService: AppConfigService) {}

  async execute(input: { tenantId: string; url: string }): Promise<ValidateFeedUrlResult> {
    const allowPrivateHosts = resolveAllowPrivateFeedHosts(this.appConfigService);

    try {
      assertSafePublicUrl(input.url, { allowPrivateHosts });
    } catch (error) {
      // No request is issued: `latencyMs` stays 0 so a blocked host cannot be
      // distinguished from another blocked host by timing.
      const code = error instanceof UnsafeProtocolError ? 'unsafe_protocol' : 'unsafe_host';
      this.logger.warn(
        `Feed validation blocked: tenant=${input.tenantId} host=${describeHostForLog(input.url)} reason=${code}`,
      );
      return emptyResult(code, { latencyMs: 0 });
    }

    const timeoutMs = clampTimeout(this.appConfigService.fetchTimeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
      const { response } = await safeFetch(
        input.url,
        { headers: VALIDATION_HEADERS, signal: controller.signal },
        { allowPrivateHosts },
      );
      const latencyMs = Date.now() - startedAt;
      const statusCode = response.status;

      if (statusCode >= 400) {
        // Release the socket without reading — the upstream body is never
        // surfaced, so there is nothing to gain by buffering it.
        await response.body?.cancel().catch(() => undefined);
        return emptyResult(`http_${statusCode}`, { latencyMs, statusCode });
      }

      const body = await readBodyWithLimit(response, resolveFeedFetchMaxBytes(this.appConfigService));
      return await this.parseFeed(body, { latencyMs, statusCode });
    } catch (error) {
      const code = mapFetchError(error);
      this.logger.warn(
        `Feed validation failed: tenant=${input.tenantId} host=${describeHostForLog(input.url)} reason=${code}`,
      );
      return emptyResult(code, { latencyMs: Date.now() - startedAt });
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseFeed(
    body: string,
    context: { latencyMs: number; statusCode: number },
  ): Promise<ValidateFeedUrlResult> {
    let parsed: Parser.Output<Record<string, unknown>>;
    try {
      parsed = await this.parser.parseString(body);
    } catch {
      // An HTML landing page, a JSON API or a truncated document all land here.
      // The parser message quotes the offending markup, so it is dropped.
      return emptyResult('parse_error', { latencyMs: context.latencyMs, statusCode: context.statusCode });
    }

    const items = parsed.items;
    const publishedDates = items
      .map((item) => normalizePublishedAt(item.isoDate ?? item.pubDate ?? null))
      .filter((value): value is string => value !== null);

    return {
      reachable: true,
      statusCode: context.statusCode,
      latencyMs: context.latencyMs,
      feedTitle: truncate(parsed.title),
      itemCount: items.length,
      latestItemPublishedAt: publishedDates.length > 0 ? publishedDates.reduce((a, b) => (a > b ? a : b)) : null,
      sampleItems: items.slice(0, SAMPLE_ITEM_COUNT).map((item) => ({
        title: truncate(item.title),
        link: sanitizeItemLink(item.link),
        publishedAt: normalizePublishedAt(item.isoDate ?? item.pubDate ?? null),
      })),
      error: null,
    };
  }
}

function emptyResult(
  error: ValidateFeedUrlErrorCode,
  context: { latencyMs: number; statusCode?: number },
): ValidateFeedUrlResult {
  return {
    reachable: (context.statusCode ?? 0) > 0 && (context.statusCode ?? 0) < 400,
    statusCode: context.statusCode ?? null,
    latencyMs: context.latencyMs,
    feedTitle: null,
    itemCount: null,
    latestItemPublishedAt: null,
    sampleItems: [],
    error,
  };
}

/**
 * Maps a thrown error onto the closed vocabulary.
 *
 * The typed errors from `url-safety` and `safe-fetch` are matched by class; only
 * once those are exhausted does it fall back to sniffing the undici `cause.code`
 * and the message. Nothing from either is copied into the return value.
 */
export function mapFetchError(error: unknown): ValidateFeedUrlErrorCode {
  if (error instanceof UnsafeProtocolError) {
    return 'unsafe_protocol';
  }
  // A redirect hop that lands on loopback, RFC1918 or cloud metadata surfaces
  // here: `safeFetch` re-validates before every hop.
  if (error instanceof UnsafeHostError) {
    return 'unsafe_host';
  }
  if (error instanceof TooManyRedirectsError) {
    return 'too_many_redirects';
  }
  if (error instanceof InvalidRedirectError) {
    return 'invalid_redirect';
  }
  if (error instanceof BodyTooLargeError) {
    return 'response_too_large';
  }
  if (!(error instanceof Error)) {
    return 'unknown';
  }
  if (error.name === 'AbortError' || error.name === 'TimeoutError') {
    return 'timeout';
  }

  const message = error.message.toLowerCase();
  const causeCode = readCauseCode(error);

  if (causeCode === 'ENOTFOUND' || causeCode === 'EAI_AGAIN' || message.includes('getaddrinfo')) {
    return 'dns_failure';
  }
  if (causeCode === 'ECONNREFUSED' || message.includes('econnrefused')) {
    return 'connection_refused';
  }
  if (
    causeCode?.startsWith('ERR_TLS') ||
    causeCode === 'CERT_HAS_EXPIRED' ||
    causeCode === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    causeCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    message.includes('certificate') ||
    message.includes('tls') ||
    message.includes('ssl')
  ) {
    return 'tls_error';
  }
  if (causeCode === 'ETIMEDOUT' || causeCode === 'UND_ERR_CONNECT_TIMEOUT' || message.includes('timeout')) {
    return 'timeout';
  }

  return 'unknown';
}

function readCauseCode(error: Error): string | undefined {
  const cause: unknown = (error as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) {
    return undefined;
  }

  const code: unknown = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function clampTimeout(configured: number): number {
  if (!Number.isFinite(configured) || configured <= 0) {
    return MAX_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(configured)));
}

/**
 * Host only, and never the credentials, path or query: a probed URL is caller
 * input that can carry `user:password@` or a token in the query string, and it
 * would be written verbatim into the operator's log pipeline.
 */
function describeHostForLog(url: string): string {
  try {
    return new URL(url).host || 'unknown';
  } catch {
    return 'unparseable';
  }
}

function truncate(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return trimmed.length > MAX_ECHOED_TEXT_LENGTH ? `${trimmed.slice(0, MAX_ECHOED_TEXT_LENGTH)}…` : trimmed;
}

/**
 * Item links are rendered by whatever UI consumes this result, so anything that
 * is not http(s) — `javascript:`, `data:`, a relative fragment — is dropped
 * rather than handed on. Private hosts are kept: the link is displayed, not
 * fetched, and hiding it would misrepresent the feed.
 */
function sanitizeItemLink(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > VALIDATED_LINK_MAX_LENGTH) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

const VALIDATED_LINK_MAX_LENGTH = 2048;

/** Same normalization the ingestion path applies, so previews match stored entries. */
function normalizePublishedAt(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
