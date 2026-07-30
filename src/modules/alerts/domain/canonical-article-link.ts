/**
 * Canonical form of an article link, used as the dedupe key for alerts.
 *
 * The goal is to collapse the same article syndicated through several feeds
 * (each one adding its own campaign parameters) into a single alert, without
 * ever collapsing two genuinely different articles. That asymmetry drives every
 * rule below:
 *
 *  - Tracking parameters are removed from an explicit DENYLIST. Stripping the
 *    query string wholesale would merge `?page=2` with `?page=3` and
 *    `?id=123` with `?id=456`, which are different articles on many CMSs.
 *  - `www.` is NOT stripped and `http` is NOT upgraded to `https`: both are
 *    routinely different origins serving different content.
 *  - Surviving parameters are sorted so parameter order stops producing
 *    duplicates.
 *  - Default ports (`:80` on http, `:443` on https) are dropped.
 *
 * Migration `0018_alerts_canonical_relink_and_index_cleanup.sql` mirrors this
 * function in SQL to recanonicalize rows written by older versions.
 */

/** Query parameters that only identify the referral, never the article. */
const TRACKING_PARAM_DENYLIST = new Set([
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'at_medium',
  'at_campaign',
  '__twitter_impression',
]);

function isTrackingParam(name: string): boolean {
  const lowerName = name.toLowerCase();
  return lowerName.startsWith('utm_') || TRACKING_PARAM_DENYLIST.has(lowerName);
}

/**
 * The only rewrite applied to a query pair: `+` and `%20` both mean a space in
 * a query string, so they must not produce two different dedupe keys.
 *
 * Nothing else is rewritten, and that is the whole point. An earlier attempt
 * tried to reproduce the WHATWG special-query percent-encode set here so the
 * parsed branch would agree with plpgsql. That set is not a short list of
 * punctuation: it is `space " ' < >` PLUS every code point above U+007E plus
 * the C0 controls, so `?q=okupacion` (with the accent) became `q=okupaci%C3%B3n`
 * through the parser and stayed raw in SQL. Chasing it character by character is
 * unwinnable. The query is now read from the ORIGINAL input string instead, so
 * the parser never touches it and there is nothing to reproduce.
 */
const QUERY_ESCAPES = { '+': '%20' } as const;

/** Query substring of the ORIGINAL input, before any URL parser can rewrite it. */
function rawQueryOf(value: string): string {
  const withoutFragment = value.split('#')[0] ?? '';
  const queryIndex = withoutFragment.indexOf('?');
  return queryIndex === -1 ? '' : withoutFragment.slice(queryIndex + 1);
}

/**
 * Canonicalizes the query WITHOUT percent-decoding or re-encoding it.
 * TRADEOFF, deliberate.
 *
 * This used to round-trip through `URLSearchParams`, whose WHATWG *form*
 * serializer rewrites `%20`->`+`, `%41`->`A`, `%2Ab`->`a*b`. Migration 0018
 * backfills the same column in plpgsql and cannot reproduce that, so a
 * backfilled row and a freshly ingested row for the SAME article stopped
 * colliding and the tenant got the duplicate alert 0018 exists to prevent.
 *
 * A byte-stable key is the only form the two can be PROVEN identical in. Its
 * cost is that `%2f` and `%2F` count as different keys, which is acceptable
 * because a single feed escapes its own links consistently, and reimplementing
 * a percent-encoding serializer in plpgsql is not maintainable.
 *
 * Callers MUST pass the query taken from the original input (see `rawQueryOf`),
 * never `URL#search`, which the parser has already rewritten.
 * Proven by canonical-link-parity.integration-spec.
 */
function canonicalizeQuery(rawQuery: string): string {
  if (!rawQuery) {
    return '';
  }

  return rawQuery
    .split('&')
    .filter((pair) => pair !== '' && !isTrackingParam(pair.split('=', 1)[0] ?? ''))
    .map((pair) => Object.entries(QUERY_ESCAPES).reduce((done, [from, to]) => done.replaceAll(from, to), pair))
    .sort()
    .join('&');
}

function normalizePath(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, '/');
  return collapsed === '/' ? '/' : collapsed.replace(/\/+$/g, '');
}

function stripDefaultPort(scheme: string, authority: string): string {
  if (scheme === 'http://') {
    return authority.replace(/:80$/, '');
  }

  if (scheme === 'https://') {
    return authority.replace(/:443$/, '');
  }

  return authority;
}

/**
 * Fallback for inputs the WHATWG URL parser rejects (relative links, hosts
 * without a scheme, malformed feed data).
 *
 * It performs exactly the same normalization steps as the parsed path — host
 * lowercasing, slash collapsing, trailing-slash removal, fragment removal,
 * tracking-parameter removal and parameter sorting — so a link does not get a
 * different canonical form only because it lacked a scheme.
 */
function canonicalizeWithoutParser(value: string): string | null {
  const withoutFragment = value.split('#')[0]?.trim() ?? '';

  if (!withoutFragment) {
    return null;
  }

  const queryIndex = withoutFragment.indexOf('?');
  const beforeQuery = queryIndex === -1 ? withoutFragment : withoutFragment.slice(0, queryIndex);
  const rawQuery = rawQueryOf(withoutFragment);

  const schemeMatch = /^[a-z][a-z0-9+.-]*:\/\//i.exec(beforeQuery);
  const scheme = schemeMatch ? schemeMatch[0].toLowerCase() : '';
  const remainder = schemeMatch ? beforeQuery.slice(schemeMatch[0].length) : beforeQuery;

  const pathIndex = remainder.indexOf('/');
  const authority = stripDefaultPort(
    scheme,
    (pathIndex === -1 ? remainder : remainder.slice(0, pathIndex)).toLowerCase(),
  );
  const path = pathIndex === -1 ? '' : normalizePath(remainder.slice(pathIndex));

  const query = canonicalizeQuery(rawQuery);
  const base = `${scheme}${authority}${path}`;
  const canonical = query ? `${base}?${query}` : base;

  return canonical || null;
}

export function canonicalizeArticleLink(link: string | null | undefined): string | null {
  if (typeof link !== 'string') {
    return null;
  }

  const trimmed = link.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();

    if (
      (parsed.protocol === 'http:' && parsed.port === '80') ||
      (parsed.protocol === 'https:' && parsed.port === '443')
    ) {
      parsed.port = '';
    }

    parsed.pathname = normalizePath(parsed.pathname);

    // The query is taken from the ORIGINAL input and appended by hand. Reading
    // `parsed.search` would hand us a string the parser already percent-encoded
    // (`?q=cafe` with an accent arrives as `q=caf%C3%A9`), and assigning
    // `parsed.search` would encode it a second time. plpgsql sees the raw bytes
    // and can do neither, so routing the query through the parser is exactly
    // what made the two implementations disagree and duplicate alerts.
    parsed.search = '';
    const base = parsed.toString();
    const query = canonicalizeQuery(rawQueryOf(trimmed));

    return query ? `${base}?${query}` : base;
  } catch {
    return canonicalizeWithoutParser(trimmed);
  }
}
