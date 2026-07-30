import { createHash } from 'node:crypto';
import { isSafePublicUrl, privateFeedHostsAllowedByEnv } from '../../../shared/http/url-safety';

export interface NormalizeFeedUrlOptions {
  /**
   * Escape hatch for self-hosted deployments. Defaults to the
   * `ALLOW_PRIVATE_FEED_HOSTS` environment flag because this helper is also
   * called from pure domain / repository code with no access to Nest DI.
   */
  allowPrivateHosts?: boolean;
}

export function normalizeFeedUrl(input: string, options: NormalizeFeedUrlOptions = {}): string {
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

  // Host validation belongs here too: an OPML file is an unvalidated bulk
  // import path, so without this a single upload could register thousands of
  // loopback / RFC1918 / metadata URLs that the worker would then fetch.
  const allowPrivateHosts = options.allowPrivateHosts ?? privateFeedHostsAllowedByEnv();
  if (!isSafePublicUrl(parsed, { allowPrivateHosts })) {
    throw new Error('feed_url_host_not_allowed');
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
