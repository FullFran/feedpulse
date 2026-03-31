import { createHash } from 'node:crypto';

export function normalizeFeedUrl(input: string): string {
  const trimmed = input.trim();

  if (!trimmed) {
    throw new Error('feed_url_empty');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('feed_url_invalid');
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error('feed_url_protocol_not_supported');
  }

  parsed.protocol = protocol;
  parsed.hostname = parsed.hostname.toLowerCase();

  if ((protocol === 'http:' && parsed.port === '80') || (protocol === 'https:' && parsed.port === '443')) {
    parsed.port = '';
  }

  const normalizedPath = parsed.pathname.replace(/\/{2,}/g, '/');
  parsed.pathname = normalizedPath === '/' ? '/' : normalizedPath.replace(/\/+$/g, '');
  parsed.hash = '';

  return parsed.toString();
}

export function buildNormalizedFeedUrlHash(normalizedUrl: string): string {
  return createHash('sha256').update(normalizedUrl).digest('hex');
}
