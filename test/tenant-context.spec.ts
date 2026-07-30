import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import {
  LEGACY_TENANT_ID,
  deriveTenantIdFromApiKey,
  deriveTenantIdFromClerkPrincipal,
  getApiKeyFromRequest,
  getBearerTokenFromRequest,
  resolveTenantIdFromRequest,
} from '../src/shared/http/tenant-context';

/**
 * GOLDEN VALUES — committed as literals on purpose.
 *
 * Recomputing them inside the test with the same algorithm would make the test tautological and
 * unable to detect the exact change it exists to catch: every row in feeds, rules, entries, alerts
 * and tenant_settings is keyed by these strings, so a change to the prefix, the hash or the slice
 * length orphans production data.
 */
const GOLDEN_API_KEY_TENANTS: ReadonlyArray<readonly [string, string]> = [
  ['demo-api-key', 'ak_ca6f2e39b2ff141859b18bb5'],
  ['fp_abcdef12_secret', 'ak_82cf8b607ccf8d4e3a7cc18b'],
  ['', 'ak_e3b0c44298fc1c149afbf4c8'],
];

const GOLDEN_CLERK_TENANTS: ReadonlyArray<readonly [string, string]> = [
  ['user_2abc', 'ck_9ef1275adf8c85cf1bb6144d'],
  ['org_2xyz', 'ck_5ef038b204ba79004db6b7ee'],
];

function fakeRequest(headers: Record<string, string> = {}, tenantId?: string): Request {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));

  return {
    tenantId,
    header: (name: string) => normalized.get(name.toLowerCase()),
  } as unknown as Request;
}

describe('tenant-context', () => {
  describe('tenant id derivation (storage format)', () => {
    it.each(GOLDEN_API_KEY_TENANTS)('maps api key %p to the committed golden tenant id', (apiKey, expected) => {
      expect(deriveTenantIdFromApiKey(apiKey)).toBe(expected);
    });

    it.each(GOLDEN_CLERK_TENANTS)(
      'maps clerk principal %p to the committed golden tenant id',
      (principal, expected) => {
        expect(deriveTenantIdFromClerkPrincipal(principal)).toBe(expected);
      },
    );

    it('keeps the derived tenant id shape stable (prefix + 24 hex characters)', () => {
      expect(deriveTenantIdFromApiKey('anything')).toMatch(/^ak_[0-9a-f]{24}$/);
      expect(deriveTenantIdFromClerkPrincipal('anything')).toMatch(/^ck_[0-9a-f]{24}$/);
    });

    it('keeps the legacy tenant id stable', () => {
      expect(LEGACY_TENANT_ID).toBe('legacy');
    });
  });

  describe('getBearerTokenFromRequest', () => {
    it('reads a bearer token case-insensitively and trims it', () => {
      expect(getBearerTokenFromRequest(fakeRequest({ authorization: 'BeArEr   token-value  ' }))).toBe('token-value');
    });

    it('returns null when the scheme is missing or the token is empty', () => {
      expect(getBearerTokenFromRequest(fakeRequest({ authorization: 'Basic abc' }))).toBeNull();
      expect(getBearerTokenFromRequest(fakeRequest({ authorization: 'Bearer    ' }))).toBeNull();
      expect(getBearerTokenFromRequest(fakeRequest())).toBeNull();
    });
  });

  describe('getApiKeyFromRequest', () => {
    it('treats a dot-free bearer token as an API key', () => {
      expect(getApiKeyFromRequest(fakeRequest({ authorization: 'Bearer fp_abcdef12_secret' }))).toBe(
        'fp_abcdef12_secret',
      );
    });

    it('DECISION: a dot-free JWT-shaped token is routed to the API key path, not the Clerk path', () => {
      // A well-formed JWT always contains two dots. A dot-free token cannot be one, so routing it
      // to the API key path is intentional: it will simply fail the api_keys lookup.
      expect(getApiKeyFromRequest(fakeRequest({ authorization: 'Bearer notajwtwithoutdots' }))).toBe(
        'notajwtwithoutdots',
      );
    });

    it('does not treat a dotted bearer token as an API key', () => {
      expect(getApiKeyFromRequest(fakeRequest({ authorization: 'Bearer header.payload.signature' }))).toBeNull();
    });

    it('falls back to the x-api-key header and trims it', () => {
      expect(getApiKeyFromRequest(fakeRequest({ 'x-api-key': '  fp_key  ' }))).toBe('fp_key');
    });

    it('prefers the dot-free bearer token over the x-api-key header', () => {
      expect(getApiKeyFromRequest(fakeRequest({ authorization: 'Bearer bearer_key', 'x-api-key': 'header_key' }))).toBe(
        'bearer_key',
      );
    });

    it('returns null when no credential is present', () => {
      expect(getApiKeyFromRequest(fakeRequest())).toBeNull();
    });
  });

  describe('resolveTenantIdFromRequest', () => {
    it('returns the tenant attached by the authentication middleware', () => {
      expect(resolveTenantIdFromRequest(fakeRequest({}, 'ak_tenant'))).toBe('ak_tenant');
    });

    it('never derives a tenant from an unverified credential', () => {
      const request = fakeRequest({ 'x-api-key': 'anything-at-all' });

      expect(() => resolveTenantIdFromRequest(request)).toThrow(UnauthorizedException);
      expect(() => resolveTenantIdFromRequest(request)).toThrow('missing_tenant_context');
      expect(request.tenantId).toBeUndefined();
    });

    it('does not grant the legacy tenant just because NODE_ENV is test', () => {
      expect(process.env.NODE_ENV).toBe('test');
      expect(() => resolveTenantIdFromRequest(fakeRequest())).toThrow('missing_tenant_context');
    });
  });
});
