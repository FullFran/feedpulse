import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { ApiKeyRecord, ApiKeysRepository } from '../src/modules/auth/api-keys.repository';
import type {
  ClerkSessionVerifierService,
  VerifiedClerkSession,
} from '../src/shared/auth/clerk-session-verifier.service';
import { HttpAuthService, KNOWN_AUTH_PROVIDERS } from '../src/shared/auth/http-auth.service';
import type { AppConfigService } from '../src/shared/config/app-config.service';
import { LEGACY_TENANT_ID, deriveTenantIdFromClerkPrincipal } from '../src/shared/http/tenant-context';

const VALID_KEY = 'fp_abcdef12_valid-secret';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.signature';

function fakeRequest(headers: Record<string, string> = {}): Request {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));

  return {
    header: (name: string) => normalized.get(name.toLowerCase()),
  } as unknown as Request;
}

class StubApiKeysRepository {
  readonly verified: string[] = [];

  constructor(private readonly keys: Map<string, string> = new Map([[VALID_KEY, 'tenant_from_database']])) {}

  async verifyApiKey(plaintextKey: string): Promise<ApiKeyRecord | null> {
    this.verified.push(plaintextKey);
    const tenantId = this.keys.get(plaintextKey);
    if (!tenantId) {
      return null;
    }

    return {
      id: '1',
      tenantId,
      prefix: 'abcdef12',
      label: null,
      createdAt: new Date(0).toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    };
  }
}

class StubClerkVerifier {
  calls = 0;

  async verify(): Promise<VerifiedClerkSession> {
    this.calls += 1;
    return { subject: 'user_1', orgId: 'org_1' };
  }
}

function buildService(options: { provider: string; enableAuth: boolean }): {
  service: HttpAuthService;
  repository: StubApiKeysRepository;
  clerk: StubClerkVerifier;
} {
  const repository = new StubApiKeysRepository();
  const clerk = new StubClerkVerifier();
  const config = {
    authProvider: options.provider,
    enableAuth: options.enableAuth,
  } as unknown as AppConfigService;

  const service = new HttpAuthService(
    config,
    clerk as unknown as ClerkSessionVerifierService,
    repository as unknown as ApiKeysRepository,
  );

  return { service, repository, clerk };
}

describe('HttpAuthService', () => {
  describe('AUTH_PROVIDER validation', () => {
    it.each(KNOWN_AUTH_PROVIDERS)('accepts the known provider %s at startup', (provider) => {
      const { service } = buildService({ provider, enableAuth: true });
      expect(() => service.onModuleInit()).not.toThrow();
    });

    it('accepts a known provider with surrounding whitespace and mixed case', () => {
      const { service } = buildService({ provider: '  Clerk_Api_Key ', enableAuth: true });
      expect(() => service.onModuleInit()).not.toThrow();
    });

    it('fails startup on an unrecognized provider instead of silently disabling both paths', () => {
      const { service } = buildService({ provider: 'oauth2', enableAuth: true });
      expect(() => service.onModuleInit()).toThrow('Unrecognized AUTH_PROVIDER "oauth2"');
    });
  });

  describe('development mode (ENABLE_AUTH=false)', () => {
    it('resolves every request to the legacy tenant without touching the credential store', async () => {
      const { service, repository } = buildService({ provider: 'clerk_api_key', enableAuth: false });
      const request = fakeRequest({ 'x-api-key': 'whatever' });

      await service.authenticateRequest(request);

      expect(request.tenantId).toBe(LEGACY_TENANT_ID);
      expect(repository.verified).toEqual([]);
    });

    it('resolves anonymous requests to the legacy tenant too', async () => {
      const { service } = buildService({ provider: 'api_key', enableAuth: false });
      const request = fakeRequest();

      await service.authenticateRequest(request);

      expect(request.tenantId).toBe(LEGACY_TENANT_ID);
    });
  });

  describe('provider matrix with ENABLE_AUTH=true', () => {
    it('api_key: accepts a stored key and resolves its stored tenant', async () => {
      const { service } = buildService({ provider: 'api_key', enableAuth: true });
      const request = fakeRequest({ 'x-api-key': VALID_KEY });

      await service.authenticateRequest(request);

      expect(request.tenantId).toBe('tenant_from_database');
      expect(request.apiKey).toBe(VALID_KEY);
    });

    it('api_key: rejects a Clerk bearer token because the Clerk path is disabled', async () => {
      const { service, clerk } = buildService({ provider: 'api_key', enableAuth: true });

      await expect(service.authenticateRequest(fakeRequest({ authorization: `Bearer ${JWT}` }))).rejects.toThrow(
        'auth_required',
      );
      expect(clerk.calls).toBe(0);
    });

    it('clerk: verifies the session and derives the tenant from the organization', async () => {
      const { service, clerk } = buildService({ provider: 'clerk', enableAuth: true });
      const request = fakeRequest({ authorization: `Bearer ${JWT}` });

      await service.authenticateRequest(request);

      expect(clerk.calls).toBe(1);
      expect(request.tenantId).toBe(deriveTenantIdFromClerkPrincipal('org_1'));
    });

    it('clerk: rejects an API key because the API key path is disabled', async () => {
      const { service, repository } = buildService({ provider: 'clerk', enableAuth: true });

      await expect(service.authenticateRequest(fakeRequest({ 'x-api-key': VALID_KEY }))).rejects.toThrow(
        'auth_required',
      );
      expect(repository.verified).toEqual([]);
    });

    it('clerk_api_key: accepts both credential types', async () => {
      const { service } = buildService({ provider: 'clerk_api_key', enableAuth: true });

      const apiKeyRequest = fakeRequest({ 'x-api-key': VALID_KEY });
      await service.authenticateRequest(apiKeyRequest);
      expect(apiKeyRequest.tenantId).toBe('tenant_from_database');

      const clerkRequest = fakeRequest({ authorization: `Bearer ${JWT}` });
      await service.authenticateRequest(clerkRequest);
      expect(clerkRequest.tenantId).toBe(deriveTenantIdFromClerkPrincipal('org_1'));
    });

    it('routes a dotted, non-JWT bearer token to the API key path', async () => {
      const { service, repository } = buildService({ provider: 'clerk_api_key', enableAuth: true });

      await expect(service.authenticateRequest(fakeRequest({ authorization: 'Bearer two.segments' }))).rejects.toThrow(
        'invalid_api_key',
      );
      expect(repository.verified).toEqual(['two.segments']);
    });

    it('rejects an unknown key with 401 invalid_api_key', async () => {
      const { service } = buildService({ provider: 'clerk_api_key', enableAuth: true });

      const error = await service
        .authenticateRequest(fakeRequest({ 'x-api-key': 'fp_unknown_key' }))
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).getStatus()).toBe(401);
      expect((error as UnauthorizedException).message).toBe('invalid_api_key');
    });

    it('rejects an anonymous request instead of falling back to the legacy tenant', async () => {
      const { service } = buildService({ provider: 'clerk_api_key', enableAuth: true });
      const request = fakeRequest();

      await expect(service.authenticateRequest(request)).rejects.toThrow('auth_required');
      expect(request.tenantId).toBeUndefined();
    });

    it('never grants the legacy tenant while auth is enabled, even under NODE_ENV=test', async () => {
      expect(process.env.NODE_ENV).toBe('test');
      const { service } = buildService({ provider: 'clerk_api_key', enableAuth: true });

      const credentialVariants: Array<Record<string, string>> = [
        {},
        { 'x-api-key': 'bogus' },
        { authorization: 'Bearer bogus' },
      ];

      for (const headers of credentialVariants) {
        const request = fakeRequest(headers);
        await expect(service.authenticateRequest(request)).rejects.toThrow(UnauthorizedException);
        expect(request.tenantId).not.toBe(LEGACY_TENANT_ID);
      }
    });

    it('keeps a tenant already resolved earlier in the request lifecycle', async () => {
      const { service, repository } = buildService({ provider: 'clerk_api_key', enableAuth: true });
      const request = fakeRequest({ 'x-api-key': VALID_KEY });
      request.tenantId = 'already_resolved';

      await service.authenticateRequest(request);

      expect(request.tenantId).toBe('already_resolved');
      expect(repository.verified).toEqual([]);
    });
  });
});
