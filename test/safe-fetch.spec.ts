import {
  BodyTooLargeError,
  InvalidRedirectError,
  TooManyRedirectsError,
  readBodyWithLimit,
  resolveFeedFetchMaxBytes,
  safeFetch,
} from '../src/shared/http/safe-fetch';
import { UnsafeHostError, UnsafeProtocolError } from '../src/shared/http/url-safety';
import { expectDefined } from './support/expect-defined';

type FetchCall = [string, RequestInit | undefined];

const originalFetch = global.fetch;

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): jest.Mock {
  const mock = jest.fn(async (url: string, init?: RequestInit) => handler(url, init));
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

function redirect(location: string, status = 302): Response {
  return new Response('redirecting', { status, headers: { location } });
}

function calls(mock: jest.Mock): FetchCall[] {
  return mock.mock.calls as FetchCall[];
}

describe('safeFetch', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('follows a 301 chain and returns the final body, headers and final URL', async () => {
    const mock = stubFetch((url) => {
      if (url === 'https://example.com/feed') {
        return redirect('https://cdn.example.com/feed.xml', 301);
      }
      return new Response('<rss/>', { status: 200, headers: { etag: 'W/"abc123"' } });
    });

    const { response, finalUrl, redirectCount } = await safeFetch('https://example.com/feed');

    expect(redirectCount).toBe(1);
    expect(finalUrl).toBe('https://cdn.example.com/feed.xml');
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('W/"abc123"');
    await expect(response.text()).resolves.toBe('<rss/>');
    expect(calls(mock).map(([url]) => url)).toEqual(['https://example.com/feed', 'https://cdn.example.com/feed.xml']);
  });

  it('always requests with manual redirect handling', async () => {
    const mock = stubFetch(() => new Response('ok', { status: 200 }));

    await safeFetch('https://example.com/feed', { headers: { accept: 'application/xml' } });

    const [, init] = expectDefined(calls(mock)[0]);
    expect(init?.redirect).toBe('manual');
    expect(init?.headers).toEqual({ accept: 'application/xml' });
  });

  it('resolves relative Location headers against the current hop', async () => {
    const mock = stubFetch((url) => {
      if (url === 'https://example.com/a/feed') {
        return redirect('../b/feed.xml');
      }
      return new Response('ok', { status: 200 });
    });

    const { finalUrl } = await safeFetch('https://example.com/a/feed');

    expect(finalUrl).toBe('https://example.com/b/feed.xml');
    expect(calls(mock)).toHaveLength(2);
  });

  it('re-validates every redirect target and blocks a 302 to cloud metadata', async () => {
    const mock = stubFetch((url) => {
      if (url === 'https://example.com/feed') {
        return redirect('http://169.254.169.254/latest/meta-data/');
      }
      return new Response('secrets', { status: 200 });
    });

    await expect(safeFetch('https://example.com/feed')).rejects.toThrow(UnsafeHostError);
    expect(calls(mock)).toHaveLength(1);
  });

  it('blocks a redirect that switches to a non-http protocol', async () => {
    stubFetch(() => redirect('file:///etc/passwd'));

    await expect(safeFetch('https://example.com/feed')).rejects.toThrow(UnsafeProtocolError);
  });

  it('rejects the initial URL before issuing any request', async () => {
    const mock = stubFetch(() => new Response('ok', { status: 200 }));

    await expect(safeFetch('http://127.0.0.1:4010/feed')).rejects.toThrow(UnsafeHostError);
    expect(mock).not.toHaveBeenCalled();
  });

  it('throws after more redirect hops than allowed', async () => {
    const mock = stubFetch((url) => {
      const hop = Number.parseInt(new URL(url).searchParams.get('hop') ?? '0', 10);
      return redirect(`https://example.com/feed?hop=${hop + 1}`);
    });

    await expect(safeFetch('https://example.com/feed?hop=0')).rejects.toThrow(TooManyRedirectsError);
    // Initial request + 5 followed hops.
    expect(calls(mock)).toHaveLength(6);
  });

  it('throws when a 3xx has no usable Location header', async () => {
    stubFetch(() => new Response('moved', { status: 301 }));

    await expect(safeFetch('https://example.com/feed')).rejects.toThrow(InvalidRedirectError);
  });

  it('downgrades POST to GET on a 303 and keeps the method on a 307', async () => {
    const mock = stubFetch((url) => {
      if (url === 'https://example.com/hook-303') {
        return redirect('https://example.com/done', 303);
      }
      if (url === 'https://example.com/hook-307') {
        return redirect('https://example.com/done', 307);
      }
      return new Response('ok', { status: 200 });
    });

    await safeFetch('https://example.com/hook-303', { method: 'POST', body: '{"a":1}' });
    const [, afterSeeOther] = expectDefined(calls(mock)[1]);
    expect(afterSeeOther?.method).toBe('GET');
    expect(afterSeeOther?.body).toBeUndefined();

    mock.mockClear();
    await safeFetch('https://example.com/hook-307', { method: 'POST', body: '{"a":1}' });
    const [, afterTemporary] = expectDefined(calls(mock)[1]);
    expect(afterTemporary?.method).toBe('POST');
    expect(afterTemporary?.body).toBe('{"a":1}');
  });

  it('honours the allow-private escape hatch on every hop', async () => {
    stubFetch((url) => {
      if (url === 'http://127.0.0.1:4010/feed') {
        return redirect('http://127.0.0.1:4010/feed.xml');
      }
      return new Response('<rss/>', { status: 200 });
    });

    const { finalUrl } = await safeFetch('http://127.0.0.1:4010/feed', {}, { allowPrivateHosts: true });

    expect(finalUrl).toBe('http://127.0.0.1:4010/feed.xml');
  });
});

describe('readBodyWithLimit', () => {
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env['FEED_FETCH_MAX_BYTES'];
  });

  it('returns the decoded body when it fits the cap', async () => {
    const response = new Response('<rss>hello</rss>', { status: 200 });

    await expect(readBodyWithLimit(response, 1024)).resolves.toBe('<rss>hello</rss>');
  });

  it('throws feed_body_too_large from the content-length header before reading a byte', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('stream must not be read');
      },
    });
    const response = new Response(body, { status: 200, headers: { 'content-length': '10485760' } });

    await expect(readBodyWithLimit(response, 1024)).rejects.toThrow(BodyTooLargeError);
    await expect(
      readBodyWithLimit(new Response('x', { status: 200, headers: { 'content-length': '10485760' } }), 1024),
    ).rejects.toThrow('feed_body_too_large');
  });

  it('throws feed_body_too_large from the stream when content-length lies', async () => {
    const chunk = new Uint8Array(512).fill(0x61);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const response = new Response(body, { status: 200, headers: { 'content-length': '4' } });

    await expect(readBodyWithLimit(response, 1024)).rejects.toThrow('feed_body_too_large');
  });

  it('decodes an ISO-8859-1 feed declared in the content-type header', async () => {
    const bytes = new Uint8Array(Buffer.from('<rss><title>ocupación</title></rss>', 'latin1'));
    const response = new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/rss+xml; charset=ISO-8859-1' },
    });

    await expect(readBodyWithLimit(response, 1024)).resolves.toContain('ocupación');
  });

  it('decodes an ISO-8859-1 feed declared only in the XML prolog', async () => {
    const xml = '<?xml version="1.0" encoding="ISO-8859-1"?><rss><title>ocupación</title></rss>';
    const response = new Response(new Uint8Array(Buffer.from(xml, 'latin1')), { status: 200 });

    await expect(readBodyWithLimit(response, 1024)).resolves.toContain('ocupación');
  });

  it('prefers utf-8 when the bytes are valid utf-8 even if a legacy charset is declared', async () => {
    const response = new Response(new Uint8Array(Buffer.from('<rss><title>ocupación</title></rss>', 'utf-8')), {
      status: 200,
      headers: { 'content-type': 'application/rss+xml; charset=ISO-8859-1' },
    });

    await expect(readBodyWithLimit(response, 1024)).resolves.toContain('ocupación');
  });

  it('falls back to a lossy utf-8 decode for unknown charset labels', async () => {
    const response = new Response(new Uint8Array(Buffer.from('ocupación', 'latin1')), {
      status: 200,
      headers: { 'content-type': 'text/xml; charset=made-up-charset' },
    });

    await expect(readBodyWithLimit(response, 1024)).resolves.toContain('ocupaci');
  });

  it('returns an empty string for a body-less response', async () => {
    await expect(readBodyWithLimit(new Response(null, { status: 304 }), 1024)).resolves.toBe('');
  });
});

describe('resolveFeedFetchMaxBytes', () => {
  afterEach(() => {
    delete process.env['FEED_FETCH_MAX_BYTES'];
  });

  it('defaults to 5 MiB', () => {
    expect(resolveFeedFetchMaxBytes(undefined)).toBe(5 * 1024 * 1024);
  });

  it('reads the environment when the configuration does not expose the property', () => {
    process.env['FEED_FETCH_MAX_BYTES'] = '2048';

    expect(resolveFeedFetchMaxBytes({ nodeEnv: 'test' })).toBe(2048);
  });

  it('prefers the injected configuration', () => {
    process.env['FEED_FETCH_MAX_BYTES'] = '2048';

    expect(resolveFeedFetchMaxBytes({ feedFetchMaxBytes: 4096 })).toBe(4096);
  });
});
