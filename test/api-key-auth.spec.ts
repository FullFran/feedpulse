import { Global, Module, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Request } from 'express';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { newDb } from 'pg-mem';
import { DatabaseService } from '../src/infrastructure/persistence/database.service';
import {
  ApiKeysRepository,
  extractApiKeyPrefix,
  generateApiKey,
  hashApiKey,
  seedBootstrapApiKey,
} from '../src/modules/auth/api-keys.repository';
import { AuthModule } from '../src/shared/auth/auth.module';
import { ClerkSessionVerifierService } from '../src/shared/auth/clerk-session-verifier.service';
import { HttpAuthService } from '../src/shared/auth/http-auth.service';
import { AppConfigService } from '../src/shared/config/app-config.service';

const MIGRATION_PATH = join(process.cwd(), 'db', 'migrations', '0014_api_keys.sql');

function fakeRequest(headers: Record<string, string> = {}): Request {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));

  return {
    header: (name: string) => normalized.get(name.toLowerCase()),
  } as unknown as Request;
}

class RejectingClerkVerifier {
  async verify(): Promise<never> {
    throw new UnauthorizedException('clerk_not_used_in_this_suite');
  }
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Stands in for the global AppConfigModule and DatabaseModule so AuthModule can be wired alone. */
let activeDatabaseService: DatabaseService;

@Global()
@Module({
  providers: [
    { provide: AppConfigService, useValue: { enableAuth: true, authProvider: 'clerk_api_key' } },
    { provide: DatabaseService, useFactory: () => activeDatabaseService },
  ],
  exports: [AppConfigService, DatabaseService],
})
class FakeInfrastructureModule {}

describe('api key authentication', () => {
  let pool: Pool;
  let repository: ApiKeysRepository;
  let service: HttpAuthService;

  beforeEach(async () => {
    const db = newDb();
    const adapter = db.adapters.createPg();
    pool = new adapter.Pool();

    // Runs the real migration so the shipped DDL is what the tests exercise.
    await pool.query(await readFile(MIGRATION_PATH, 'utf8'));

    activeDatabaseService = new DatabaseService(pool);
    repository = new ApiKeysRepository(activeDatabaseService);
    service = new HttpAuthService(
      { enableAuth: true, authProvider: 'clerk_api_key' } as unknown as AppConfigService,
      new RejectingClerkVerifier() as unknown as ClerkSessionVerifierService,
      repository,
    );
  });

  describe('key generation and storage', () => {
    it('issues a key in the documented format and never stores the plaintext', async () => {
      const created = await repository.create({ tenantId: 'tenant_alpha', label: 'ci' });

      expect(created.plaintextKey).toMatch(/^fp_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
      expect(created.record.tenantId).toBe('tenant_alpha');
      expect(created.record.label).toBe('ci');
      expect(created.record.prefix).toBe(created.plaintextKey.split('_')[1]);
      expect(created.record.revokedAt).toBeNull();

      const stored = await pool.query('SELECT key_hash FROM api_keys WHERE id = $1', [created.record.id]);
      expect(stored.rows[0].key_hash).toBe(hashApiKey(created.plaintextKey));
      expect(stored.rows[0].key_hash).not.toContain(created.plaintextKey);
    });

    it('generates a distinct secret every time', () => {
      const first = generateApiKey();
      const second = generateApiKey();

      expect(first.plaintextKey).not.toBe(second.plaintextKey);
      expect(first.keyHash).not.toBe(second.keyHash);
    });

    it('derives the display prefix from the key format and degrades gracefully', () => {
      expect(extractApiKeyPrefix('fp_abcdef12_secret')).toBe('abcdef12');
      expect(extractApiKeyPrefix('legacy-plain-key')).toBe('legacy-p');
    });
  });

  describe('authentication decisions', () => {
    it('rejects an unknown key with 401', async () => {
      const error = await service
        .authenticateRequest(fakeRequest({ 'x-api-key': 'fp_00000000_never-issued' }))
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).getStatus()).toBe(401);
      expect((error as UnauthorizedException).message).toBe('invalid_api_key');
    });

    it('rejects a revoked key', async () => {
      const created = await repository.create({ tenantId: 'tenant_alpha' });

      const request = fakeRequest({ 'x-api-key': created.plaintextKey });
      await service.authenticateRequest(request);
      expect(request.tenantId).toBe('tenant_alpha');

      await expect(repository.revoke(created.record.id)).resolves.toBe(true);

      await expect(service.authenticateRequest(fakeRequest({ 'x-api-key': created.plaintextKey }))).rejects.toThrow(
        'invalid_api_key',
      );
      await expect(repository.verifyApiKey(created.plaintextKey)).resolves.toBeNull();
    });

    it('reports a second revocation of the same key as a no-op', async () => {
      const created = await repository.create({ tenantId: 'tenant_alpha' });

      await expect(repository.revoke(created.record.id)).resolves.toBe(true);
      await expect(repository.revoke(created.record.id)).resolves.toBe(false);
    });

    it('resolves a valid key to its stored tenant', async () => {
      const created = await repository.create({ tenantId: 'tenant_alpha', label: 'primary' });
      const request = fakeRequest({ 'x-api-key': created.plaintextKey });

      await service.authenticateRequest(request);

      expect(request.tenantId).toBe('tenant_alpha');
      expect(request.apiKey).toBe(created.plaintextKey);
    });

    it('accepts the key over the Authorization bearer header as well', async () => {
      const created = await repository.create({ tenantId: 'tenant_alpha' });
      const request = fakeRequest({ authorization: `Bearer ${created.plaintextKey}` });

      await service.authenticateRequest(request);

      expect(request.tenantId).toBe('tenant_alpha');
    });

    it('resolves two distinct keys of the same tenant to that same tenant', async () => {
      const first = await repository.create({ tenantId: 'tenant_alpha', label: 'laptop' });
      const second = await repository.create({ tenantId: 'tenant_alpha', label: 'ci' });

      expect(first.plaintextKey).not.toBe(second.plaintextKey);

      const firstRequest = fakeRequest({ 'x-api-key': first.plaintextKey });
      const secondRequest = fakeRequest({ 'x-api-key': second.plaintextKey });

      await service.authenticateRequest(firstRequest);
      await service.authenticateRequest(secondRequest);

      expect(firstRequest.tenantId).toBe('tenant_alpha');
      expect(secondRequest.tenantId).toBe('tenant_alpha');
    });

    it('keeps tenants isolated', async () => {
      const alpha = await repository.create({ tenantId: 'tenant_alpha' });
      const beta = await repository.create({ tenantId: 'tenant_beta' });

      await expect(repository.verifyApiKey(alpha.plaintextKey)).resolves.toMatchObject({ tenantId: 'tenant_alpha' });
      await expect(repository.verifyApiKey(beta.plaintextKey)).resolves.toMatchObject({ tenantId: 'tenant_beta' });
    });

    it('rejects an empty or whitespace-only key without querying the database', async () => {
      const querySpy = jest.spyOn(pool, 'query');

      await expect(repository.verifyApiKey('   ')).resolves.toBeNull();
      expect(querySpy).not.toHaveBeenCalled();
    });

    it('rejects a key whose hash only differs in one character', async () => {
      const created = await repository.create({ tenantId: 'tenant_alpha' });
      const tampered = `${created.plaintextKey.slice(0, -1)}${created.plaintextKey.endsWith('A') ? 'B' : 'A'}`;

      await expect(repository.verifyApiKey(tampered)).resolves.toBeNull();
    });
  });

  describe('usage tracking', () => {
    it('records last_used_at on a successful authentication', async () => {
      const created = await repository.create({ tenantId: 'tenant_alpha' });
      expect(created.record.lastUsedAt).toBeNull();

      await repository.verifyApiKey(created.plaintextKey);
      await flushMicrotasks();

      const stored = await pool.query('SELECT last_used_at FROM api_keys WHERE id = $1', [created.record.id]);
      expect(stored.rows[0].last_used_at).not.toBeNull();
    });

    it('never fails the request when usage tracking blows up', async () => {
      const created = await repository.create({ tenantId: 'tenant_alpha' });
      const realQuery = pool.query.bind(pool);

      jest.spyOn(pool, 'query').mockImplementation(((text: string, values?: unknown[]) => {
        if (text.includes('UPDATE api_keys SET last_used_at')) {
          return Promise.reject(new Error('database unavailable'));
        }

        return realQuery(text, values as never);
      }) as never);

      await expect(repository.verifyApiKey(created.plaintextKey)).resolves.toMatchObject({ tenantId: 'tenant_alpha' });
      await expect(repository.touchLastUsed(created.record.id)).resolves.toBeUndefined();
      await flushMicrotasks();
    });
  });

  describe('bootstrap seeding', () => {
    it('seeds a well-known key once and is idempotent on re-run', async () => {
      const plaintextKey = 'fp_bootstr_local-development-key';

      await expect(seedBootstrapApiKey(pool, { plaintextKey, tenantId: 'legacy' })).resolves.toBe(true);
      await expect(seedBootstrapApiKey(pool, { plaintextKey, tenantId: 'legacy' })).resolves.toBe(false);

      const rows = await pool.query('SELECT tenant_id, label FROM api_keys');
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({ tenant_id: 'legacy', label: 'bootstrap' });

      const request = fakeRequest({ 'x-api-key': plaintextKey });
      await service.authenticateRequest(request);
      expect(request.tenantId).toBe('legacy');
    });

    it('ignores an empty bootstrap key', async () => {
      await expect(seedBootstrapApiKey(pool, { plaintextKey: '  ', tenantId: 'legacy' })).resolves.toBe(false);

      const rows = await pool.query('SELECT id FROM api_keys');
      expect(rows.rows).toHaveLength(0);
    });
  });

  describe('dependency injection wiring', () => {
    it('resolves HttpAuthService with its API key repository from the shared AuthModule', async () => {
      const moduleRef = await Test.createTestingModule({ imports: [FakeInfrastructureModule, AuthModule] }).compile();

      const resolved = moduleRef.get(HttpAuthService);
      expect(resolved).toBeInstanceOf(HttpAuthService);
      expect(moduleRef.get(ApiKeysRepository)).toBeInstanceOf(ApiKeysRepository);

      const created = await moduleRef.get(ApiKeysRepository).create({ tenantId: 'tenant_wired' });
      const request = fakeRequest({ 'x-api-key': created.plaintextKey });
      await resolved.authenticateRequest(request);
      expect(request.tenantId).toBe('tenant_wired');

      await moduleRef.close();
    });
  });

  describe('tenant key listing', () => {
    it('lists every key of a tenant, revoked ones included', async () => {
      const active = await repository.create({ tenantId: 'tenant_alpha', label: 'active' });
      const revoked = await repository.create({ tenantId: 'tenant_alpha', label: 'revoked' });
      await repository.create({ tenantId: 'tenant_beta', label: 'other' });
      await repository.revoke(revoked.record.id);

      const listed = await repository.listByTenantId('tenant_alpha');

      expect(listed.map((key) => key.label).sort()).toEqual(['active', 'revoked']);
      expect(listed.every((key) => key.tenantId === 'tenant_alpha')).toBe(true);
      expect(listed.find((key) => key.id === active.record.id)?.revokedAt).toBeNull();
      expect(listed.find((key) => key.id === revoked.record.id)?.revokedAt).not.toBeNull();
    });
  });
});
