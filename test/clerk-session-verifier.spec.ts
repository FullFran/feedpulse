import { UnauthorizedException } from '@nestjs/common';
import { ClerkSessionVerifierService } from '../src/shared/auth/clerk-session-verifier.service';
import type { AppConfigService } from '../src/shared/config/app-config.service';

const originalFetch = globalThis.fetch;

function encodeSegment(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function buildToken(payload: unknown): string {
  return `${encodeSegment({ alg: 'HS256', typ: 'JWT' })}.${encodeSegment(payload)}.signature`;
}

function buildVerifier(overrides: Partial<{ clerkSecretKey: string | undefined }> = {}): ClerkSessionVerifierService {
  const config = {
    clerkSecretKey: 'sk_test_secret',
    clerkApiUrl: 'https://clerk.example',
    webhookNotifierTimeoutMs: 500,
    ...overrides,
  } as unknown as AppConfigService;

  return new ClerkSessionVerifierService(config);
}

function stubFetch(response: { ok: boolean; body?: unknown }): jest.Mock {
  const mock = jest.fn(async () => ({
    ok: response.ok,
    json: async () => response.body ?? {},
  }));

  globalThis.fetch = mock as unknown as typeof globalThis.fetch;
  return mock;
}

describe('ClerkSessionVerifierService', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('token shape rejections (no upstream call)', () => {
    it('rejects a token that does not have three segments', async () => {
      const fetchMock = stubFetch({ ok: true });

      await expect(buildVerifier().verify('header.payload')).rejects.toThrow('invalid_clerk_token');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a payload segment that is not JSON', async () => {
      const fetchMock = stubFetch({ ok: true });
      const token = `${encodeSegment({ alg: 'HS256' })}.bm90LWpzb24.signature`;

      await expect(buildVerifier().verify(token)).rejects.toThrow('invalid_clerk_token_payload');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a payload without a subject', async () => {
      stubFetch({ ok: true });

      await expect(buildVerifier().verify(buildToken({ sid: 'sess_1' }))).rejects.toThrow(
        'invalid_clerk_token_subject',
      );
    });

    it('rejects a non-string subject', async () => {
      stubFetch({ ok: true });

      await expect(buildVerifier().verify(buildToken({ sub: 42, sid: 'sess_1' }))).rejects.toThrow(
        'invalid_clerk_token_subject',
      );
    });

    it('rejects an expired token', async () => {
      const fetchMock = stubFetch({ ok: true });
      const expired = buildToken({ sub: 'user_1', sid: 'sess_1', exp: Math.floor(Date.now() / 1000) - 1 });

      await expect(buildVerifier().verify(expired)).rejects.toThrow('clerk_token_expired');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a token without a session id', async () => {
      const fetchMock = stubFetch({ ok: true });

      await expect(buildVerifier().verify(buildToken({ sub: 'user_1' }))).rejects.toThrow('clerk_session_missing_sid');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects when CLERK_SECRET_KEY is not configured', async () => {
      const fetchMock = stubFetch({ ok: true });

      await expect(
        buildVerifier({ clerkSecretKey: undefined }).verify(buildToken({ sub: 'user_1', sid: 'sess_1' })),
      ).rejects.toThrow('clerk_secret_key_missing');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('session lookup rejections', () => {
    it('rejects when the Clerk API answers with a non-ok status', async () => {
      stubFetch({ ok: false });

      await expect(buildVerifier().verify(buildToken({ sub: 'user_1', sid: 'sess_1' }))).rejects.toThrow(
        'clerk_session_invalid',
      );
    });

    it('rejects when the session is not active', async () => {
      stubFetch({ ok: true, body: { status: 'revoked', user_id: 'user_1' } });

      await expect(buildVerifier().verify(buildToken({ sub: 'user_1', sid: 'sess_1' }))).rejects.toThrow(
        'clerk_session_not_active',
      );
    });

    it('rejects token substitution: the session belongs to another user', async () => {
      stubFetch({ ok: true, body: { status: 'active', user_id: 'user_victim' } });

      const error = await buildVerifier()
        .verify(buildToken({ sub: 'user_attacker', sid: 'sess_victim' }))
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).message).toBe('clerk_session_not_active');
    });
  });

  describe('successful verification', () => {
    it('DESIGN: authority comes from the server-side session lookup, not from the JWT signature', async () => {
      const fetchMock = stubFetch({ ok: true, body: { status: 'active', user_id: 'user_1' } });

      // The signature segment is deliberately bogus; the session lookup is what grants access.
      const session = await buildVerifier().verify(buildToken({ sub: 'user_1', sid: 'sess_1', org_id: 'org_1' }));

      expect(session).toEqual({ subject: 'user_1', orgId: 'org_1' });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
      expect(url).toBe('https://clerk.example/v1/sessions/sess_1');
      expect(init.headers.authorization).toBe('Bearer sk_test_secret');
    });

    it('returns a null organization when the session has none', async () => {
      stubFetch({ ok: true, body: { status: 'active', user_id: 'user_1' } });

      await expect(buildVerifier().verify(buildToken({ sub: 'user_1', sid: 'sess_1' }))).resolves.toEqual({
        subject: 'user_1',
        orgId: null,
      });
    });

    it('treats an empty organization id as absent', async () => {
      stubFetch({ ok: true, body: { status: 'active', user_id: 'user_1' } });

      await expect(buildVerifier().verify(buildToken({ sub: 'user_1', sid: 'sess_1', org_id: '' }))).resolves.toEqual({
        subject: 'user_1',
        orgId: null,
      });
    });
  });
});
