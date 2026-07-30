import { canonicalizeArticleLink } from '../src/modules/alerts/domain/canonical-article-link';

describe('canonicalizeArticleLink', () => {
  it('returns null for absent or blank input', () => {
    expect(canonicalizeArticleLink(null)).toBeNull();
    expect(canonicalizeArticleLink(undefined)).toBeNull();
    expect(canonicalizeArticleLink('')).toBeNull();
    expect(canonicalizeArticleLink('   ')).toBeNull();
    expect(canonicalizeArticleLink('#only-a-fragment')).toBeNull();
  });

  it('drops the trailing slash but keeps the bare root', () => {
    expect(canonicalizeArticleLink('https://example.com/articles/ai-news/')).toBe(
      'https://example.com/articles/ai-news',
    );
    expect(canonicalizeArticleLink('https://example.com/')).toBe('https://example.com/');
  });

  it('collapses repeated slashes in the path', () => {
    expect(canonicalizeArticleLink('https://example.com//articles///ai-news//')).toBe(
      'https://example.com/articles/ai-news',
    );
  });

  it('lowercases the host but preserves path case', () => {
    expect(canonicalizeArticleLink('https://Example.COM/Articles/AI-News')).toBe(
      'https://example.com/Articles/AI-News',
    );
  });

  it('drops the fragment', () => {
    expect(canonicalizeArticleLink('https://example.com/articles/ai-news#comments')).toBe(
      'https://example.com/articles/ai-news',
    );
  });

  it('strips tracking parameters', () => {
    expect(
      canonicalizeArticleLink(
        'https://example.com/a?utm_source=newsletter&utm_medium=email&fbclid=abc&gclid=def&mc_cid=1&mc_eid=2&ref=home&ref_src=twsrc&at_medium=rss&at_campaign=x&__twitter_impression=true',
      ),
    ).toBe('https://example.com/a');
  });

  it('keeps parameters that identify the article', () => {
    expect(canonicalizeArticleLink('https://example.com/articles?page=2')).toBe('https://example.com/articles?page=2');
    expect(canonicalizeArticleLink('https://example.com/index.php?id=123&utm_source=x')).toBe(
      'https://example.com/index.php?id=123',
    );
  });

  it('sorts surviving parameters so ordering stops producing duplicates', () => {
    const a = canonicalizeArticleLink('https://example.com/a?b=2&a=1&utm_source=x');
    const b = canonicalizeArticleLink('https://example.com/a?a=1&b=2');

    expect(a).toBe('https://example.com/a?a=1&b=2');
    expect(a).toBe(b);
  });

  it('keeps percent-escapes byte-for-byte and folds `+`, spaces and parser escapes', () => {
    // The old URLSearchParams round-trip rewrote these to `title=a+b`, `p=%2Fx`,
    // `n=A` and `s=a*b`; migration 0018's plpgsql reproduces none of that. Note
    // `%2f` and `%2F` staying distinct: the documented cost of byte stability.
    const link = (query: string): string | null => canonicalizeArticleLink(`https://example.com/a?${query}`);

    for (const query of ['title=a%20b', 'p=%2fx', 'p=%2Fx', 'n=%41', 's=a%2Ab', 'e=caf%C3%A9']) {
      expect(link(query)).toBe(`https://example.com/a?${query}`);
    }

    // `+` and `%20` both mean a space, so they must fold to one key. That is
    // the ONLY rewrite; everything else is passed through byte-for-byte.
    expect(link('t=a+b')).toBe('https://example.com/a?t=a%20b');
    expect(link('t=a b')).toBe('https://example.com/a?t=a b');
    // Ordinal pair ordering, which is what plpgsql `COLLATE "C"` reproduces.
    expect(link('a_b=1&aab=1&B=1')).toBe('https://example.com/a?B=1&a_b=1&aab=1');
    expect(canonicalizeArticleLink(`example.com/a?q=it's&r=<x>`)).toBe(`example.com/a?q=it's&r=<x>`);

    // Raw non-ASCII survives untouched. Reading the query off `URL#search`
    // returned `q=okupaci%C3%B3n` here while plpgsql kept the raw bytes, so the
    // same Spanish article was alerted twice. The query now comes from the
    // original input, so the parser never sees it.
    expect(link('q=okupación')).toBe('https://example.com/a?q=okupación');
    expect(link('s=café&t=1')).toBe('https://example.com/a?s=café&t=1');
    expect(link('q=中文')).toBe('https://example.com/a?q=中文');
  });

  it('drops default ports without rewriting the scheme', () => {
    expect(canonicalizeArticleLink('http://example.com:80/a')).toBe('http://example.com/a');
    expect(canonicalizeArticleLink('https://example.com:443/a')).toBe('https://example.com/a');
    expect(canonicalizeArticleLink('https://example.com:8443/a')).toBe('https://example.com:8443/a');
  });

  it('does not strip www and does not upgrade http to https', () => {
    expect(canonicalizeArticleLink('http://www.example.com/a')).toBe('http://www.example.com/a');
    expect(canonicalizeArticleLink('https://www.example.com/a')).not.toBe(
      canonicalizeArticleLink('https://example.com/a'),
    );
  });

  it('collapses the same article syndicated with different campaign tags', () => {
    const fromNewsletter = canonicalizeArticleLink('https://Example.com/Articles/AI-News/?utm_source=newsletter#top');
    const fromTwitter = canonicalizeArticleLink('https://example.com//Articles/AI-News?fbclid=xyz');

    expect(fromNewsletter).toBe('https://example.com/Articles/AI-News');
    expect(fromNewsletter).toBe(fromTwitter);
  });

  it('applies the same normalization to input the URL parser rejects', () => {
    const parsed = canonicalizeArticleLink('https://Example.COM//Articles///AI-News/?utm_source=x&b=2&a=1#top');
    const unparsed = canonicalizeArticleLink('Example.COM//Articles///AI-News/?utm_source=x&b=2&a=1#top');

    expect(parsed).toBe('https://example.com/Articles/AI-News?a=1&b=2');
    expect(unparsed).toBe('example.com/Articles/AI-News?a=1&b=2');
    expect(unparsed).toBe(parsed?.replace('https://', ''));
  });

  it('keeps relative links usable as a dedupe key', () => {
    expect(canonicalizeArticleLink('/articles//ai-news/#top')).toBe('/articles/ai-news');
  });
});
