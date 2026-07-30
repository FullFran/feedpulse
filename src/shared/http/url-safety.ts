/**
 * Defence in depth against SSRF for every outbound HTTP call whose target
 * comes from stored data (feed URLs, tenant webhooks, OPML imports and every
 * redirect hop of those requests).
 *
 * Even when a URL does not come straight from the client, we validate it
 * before each outbound request so that any change allowing arbitrary URLs to
 * be registered (admin importing feeds, a future edit endpoint, an OPML file)
 * cannot turn into a direct SSRF vector against cloud metadata endpoints,
 * loopback or private networks.
 *
 * ## Not implemented: DNS rebinding protection
 *
 * This module validates the *hostname literal* only. A hostname that resolves
 * to a public address at validation time and to a private address at connect
 * time (classic DNS rebinding / TOCTOU) is NOT blocked here. Closing that
 * window requires resolving the host once and pinning the connection to the
 * validated IP through a custom dispatcher (undici `Agent` with a fixed
 * connect-time lookup), which Node's global `fetch` cannot express. Half
 * implementing it (resolve + check, then let fetch resolve again) buys nothing
 * but a false sense of safety, so it is deliberately left out and tracked as
 * follow-up work.
 */

/**
 * Hostname patterns that must never be reached from a server-side fetch.
 * Compared against the lower-cased hostname with IPv6 brackets stripped.
 */
const BLOCKED_HOSTS: RegExp[] = [
  /^localhost$/i,
  /^127\./, // 127.0.0.0/8 loopback
  /^169\.254\./, // link-local + AWS/Azure/GCP metadata
  /^10\./, // 10.0.0.0/8
  /^192\.168\./, // 192.168.0.0/16
  /^172\.(1[6-9]|2[0-9]|3[01])\./, // 172.16.0.0/12
  /^::1$/i, // IPv6 loopback
  /^fe80:/i, // IPv6 link-local
  /^fc[0-9a-f]{2}:/i, // IPv6 unique local
  /^fd[0-9a-f]{2}:/i, // IPv6 unique local
  /^0(\.\d{1,3}){1,3}$/, // 0.0.0.0/8 "this network" — an alias for loopback on Linux
  /^::$/, // IPv6 unspecified address
];

/** Suffixes reserved for internal / link-local name resolution. */
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

export interface UrlSafetyOptions {
  /**
   * Escape hatch for self-hosted deployments (homelab feeds behind RFC1918
   * addresses) and for the docker smoke stack, which serves its fixture feed
   * from `http://127.0.0.1:4010`. Wired from `ALLOW_PRIVATE_FEED_HOSTS`.
   * The protocol whitelist is still enforced when this is enabled.
   */
  allowPrivateHosts?: boolean;
}

export class UnsafeProtocolError extends Error {
  constructor() {
    super('unsafe_protocol');
    this.name = 'UnsafeProtocolError';
  }
}

export class UnsafeHostError extends Error {
  constructor() {
    super('unsafe_host');
    this.name = 'UnsafeHostError';
  }
}

/**
 * Throws {@link UnsafeProtocolError} for anything that is not http/https and
 * {@link UnsafeHostError} for loopback, private, link-local, unspecified or
 * internal-only hostnames.
 *
 * @returns the parsed URL, so callers can reuse it without parsing twice.
 */
export function assertSafePublicUrl(url: string | URL, options: UrlSafetyOptions = {}): URL {
  let parsed: URL;
  try {
    parsed = url instanceof URL ? url : new URL(url);
  } catch {
    throw new UnsafeProtocolError();
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeProtocolError();
  }

  if (options.allowPrivateHosts) {
    return parsed;
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname) {
    throw new UnsafeHostError();
  }

  if (isBlockedHostname(hostname)) {
    throw new UnsafeHostError();
  }

  return parsed;
}

/** Non-throwing variant, for call sites that only need a boolean. */
export function isSafePublicUrl(url: string | URL, options: UrlSafetyOptions = {}): boolean {
  try {
    assertSafePublicUrl(url, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fallback used by call sites that have no access to `AppConfigService`
 * (pure domain helpers, repository hashing). Reads the same environment
 * variable the Nest configuration is built from.
 */
export function privateFeedHostsAllowedByEnv(): boolean {
  const raw = process.env['ALLOW_PRIVATE_FEED_HOSTS']?.trim().toLowerCase();
  // Same truthy vocabulary as the `featureFlag` parser in `env.schema.ts`.
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Reads the private-host escape hatch from the injected configuration when it
 * exposes `allowPrivateFeedHosts`, falling back to the raw environment.
 * Structural read (instead of a hard dependency on `AppConfigService`) keeps
 * this module usable from domain code and from adapters alike.
 */
export function resolveAllowPrivateFeedHosts(config?: object | null): boolean {
  const value = (config as { allowPrivateFeedHosts?: unknown } | null | undefined)?.allowPrivateFeedHosts;
  return typeof value === 'boolean' ? value : privateFeedHostsAllowedByEnv();
}

/**
 * Lower-cases the hostname, strips the brackets Node keeps around IPv6
 * literals (`http://[::1]/` yields hostname `[::1]`) and unwraps IPv4-mapped
 * IPv6 addresses (`::ffff:127.0.0.1`, `::ffff:7f00:1`) so the IPv4 patterns
 * still apply to them.
 */
function normalizeHostname(rawHostname: string): string {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = hostname.match(/^::ffff:(.+)$/);
  const tail = mapped?.[1];

  if (tail === undefined) {
    return hostname;
  }

  if (tail.includes('.')) {
    return tail;
  }

  const groups = tail.split(':');
  const highGroup = groups[0];
  const lowGroup = groups[1];

  if (
    groups.length !== 2 ||
    highGroup === undefined ||
    lowGroup === undefined ||
    !/^[0-9a-f]{1,4}$/.test(highGroup) ||
    !/^[0-9a-f]{1,4}$/.test(lowGroup)
  ) {
    return hostname;
  }

  const high = Number.parseInt(highGroup, 16);
  const low = Number.parseInt(lowGroup, 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function isBlockedHostname(hostname: string): boolean {
  if (BLOCKED_HOSTS.some((pattern) => pattern.test(hostname))) {
    return true;
  }

  const withoutTrailingDot = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => withoutTrailingDot.endsWith(suffix))) {
    return true;
  }

  // Single-label hosts (`http://intranet/`, `http://metadata/`) only resolve
  // inside a private network, and decimal/octal IP obfuscation
  // (`http://2130706433/`) also lands here. IPv6 literals contain ':' and are
  // handled by the pattern list above.
  return !withoutTrailingDot.includes('.') && !withoutTrailingDot.includes(':');
}
