import {
  UnsafeHostError,
  UnsafeProtocolError,
  assertSafePublicUrl,
  isSafePublicUrl,
  privateFeedHostsAllowedByEnv,
  resolveAllowPrivateFeedHosts,
} from '../src/shared/http/url-safety';

describe('assertSafePublicUrl', () => {
  const originalFlag = process.env['ALLOW_PRIVATE_FEED_HOSTS'];

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env['ALLOW_PRIVATE_FEED_HOSTS'];
    } else {
      process.env['ALLOW_PRIVATE_FEED_HOSTS'] = originalFlag;
    }
  });

  it('accepts public http and https URLs', () => {
    expect(() => assertSafePublicUrl('https://example.com/rss.xml')).not.toThrow();
    expect(() => assertSafePublicUrl('http://feeds.example.org:8080/atom')).not.toThrow();
  });

  it('returns the parsed URL so callers do not parse twice', () => {
    const parsed = assertSafePublicUrl('https://example.com/rss.xml?a=1');

    expect(parsed.hostname).toBe('example.com');
    expect(parsed.search).toBe('?a=1');
  });

  it.each([
    ['localhost', 'http://localhost/feed.xml'],
    ['127.0.0.0/8 loopback', 'http://127.0.0.1:4010/feed.xml'],
    ['169.254.0.0/16 metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['10.0.0.0/8', 'http://10.1.2.3/feed.xml'],
    ['192.168.0.0/16', 'http://192.168.1.10/feed.xml'],
    ['172.16.0.0/12', 'http://172.20.0.5/feed.xml'],
    ['IPv6 loopback', 'http://[::1]/feed.xml'],
    ['IPv6 link-local', 'http://[fe80::1]/feed.xml'],
    ['IPv6 unique local fc00::/8', 'http://[fc00::1]/feed.xml'],
    ['IPv6 unique local fd00::/8', 'http://[fd12:3456::1]/feed.xml'],
  ])('rejects %s', (_label, url) => {
    expect(() => assertSafePublicUrl(url)).toThrow(UnsafeHostError);
    expect(() => assertSafePublicUrl(url)).toThrow('unsafe_host');
  });

  it('rejects every 172.16.0.0/12 boundary but allows neighbouring public ranges', () => {
    expect(() => assertSafePublicUrl('http://172.16.0.1/')).toThrow(UnsafeHostError);
    expect(() => assertSafePublicUrl('http://172.31.255.254/')).toThrow(UnsafeHostError);
    expect(() => assertSafePublicUrl('http://172.15.0.1/')).not.toThrow();
    expect(() => assertSafePublicUrl('http://172.32.0.1/')).not.toThrow();
  });

  it('rejects non-http(s) protocols', () => {
    expect(() => assertSafePublicUrl('ftp://example.com/feed.xml')).toThrow(UnsafeProtocolError);
    expect(() => assertSafePublicUrl('file:///etc/passwd')).toThrow(UnsafeProtocolError);
    expect(() => assertSafePublicUrl('not a url at all')).toThrow(UnsafeProtocolError);
  });

  it('rejects bare hostnames with no TLD and internal-only suffixes', () => {
    expect(() => assertSafePublicUrl('http://intranet/feed.xml')).toThrow(UnsafeHostError);
    expect(() => assertSafePublicUrl('http://metadata/computeMetadata/v1/')).toThrow(UnsafeHostError);
    expect(() => assertSafePublicUrl('http://2130706433/')).toThrow(UnsafeHostError);
    expect(() => assertSafePublicUrl('http://nas.local/feed.xml')).toThrow(UnsafeHostError);
    expect(() => assertSafePublicUrl('http://api.internal/feed.xml')).toThrow(UnsafeHostError);
  });

  it('rejects the unspecified and "this network" addresses', () => {
    expect(() => assertSafePublicUrl('http://0.0.0.0:8080/')).toThrow(UnsafeHostError);
    expect(() => assertSafePublicUrl('http://[::]/')).toThrow(UnsafeHostError);
  });

  it('rejects IPv4-mapped IPv6 loopback in both notations', () => {
    expect(() => assertSafePublicUrl('http://[::ffff:127.0.0.1]/')).toThrow(UnsafeHostError);
    expect(() => assertSafePublicUrl('http://[::ffff:7f00:1]/')).toThrow(UnsafeHostError);
  });

  it('honours the allow-private escape hatch for hosts but never for protocols', () => {
    expect(() => assertSafePublicUrl('http://127.0.0.1:4010/feed.xml', { allowPrivateHosts: true })).not.toThrow();
    expect(() => assertSafePublicUrl('http://[::1]/feed.xml', { allowPrivateHosts: true })).not.toThrow();
    expect(() => assertSafePublicUrl('ftp://127.0.0.1/feed.xml', { allowPrivateHosts: true })).toThrow(
      UnsafeProtocolError,
    );
  });
});

describe('isSafePublicUrl', () => {
  it('mirrors assertSafePublicUrl without throwing', () => {
    expect(isSafePublicUrl('https://example.com/rss.xml')).toBe(true);
    expect(isSafePublicUrl('http://10.0.0.1/rss.xml')).toBe(false);
    expect(isSafePublicUrl('http://10.0.0.1/rss.xml', { allowPrivateHosts: true })).toBe(true);
  });
});

describe('private host flag resolution', () => {
  const originalFlag = process.env['ALLOW_PRIVATE_FEED_HOSTS'];

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env['ALLOW_PRIVATE_FEED_HOSTS'];
    } else {
      process.env['ALLOW_PRIVATE_FEED_HOSTS'] = originalFlag;
    }
  });

  it('defaults to false when the environment flag is absent', () => {
    delete process.env['ALLOW_PRIVATE_FEED_HOSTS'];

    expect(privateFeedHostsAllowedByEnv()).toBe(false);
    expect(resolveAllowPrivateFeedHosts(undefined)).toBe(false);
  });

  it('reads the environment flag when the config does not expose the property', () => {
    process.env['ALLOW_PRIVATE_FEED_HOSTS'] = 'true';

    expect(privateFeedHostsAllowedByEnv()).toBe(true);
    expect(resolveAllowPrivateFeedHosts({ nodeEnv: 'test' })).toBe(true);
  });

  it('prefers the injected configuration over the environment', () => {
    process.env['ALLOW_PRIVATE_FEED_HOSTS'] = 'true';

    expect(resolveAllowPrivateFeedHosts({ allowPrivateFeedHosts: false })).toBe(false);
  });
});
