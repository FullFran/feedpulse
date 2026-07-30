import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { SettingsRepository } from '../src/modules/settings/settings.repository';
import type { TenantEncryptedSecret, TenantSettings } from '../src/modules/settings/settings.repository';
import { TelegramBotTokenResolverService } from '../src/modules/settings/telegram-bot-token-resolver.service';
import {
  CURRENT_TENANT_SECRET_KEY_VERSION,
  TENANT_SECRET_KEY_VERSION_LEGACY_SHA256,
  TenantSecretsService,
} from '../src/modules/settings/tenant-secrets.service';
import type { AppConfigService } from '../src/shared/config/app-config.service';
import { expectDefined } from './support/expect-defined';

/**
 * How the notifier decides WHICH Telegram bot speaks for a tenant.
 *
 * The rule this suite exists to pin down: a tenant that HAS a stored bot token
 * whose ciphertext will not open must get NO token at all. The previous
 * behaviour - log a WARN and quietly hand back the operator's global
 * `TELEGRAM_BOT_TOKEN` - meant a botched `TENANT_SECRETS_MASTER_KEY` rotation
 * rerouted every tenant's alerts through the operator's own bot, with no
 * failure anywhere an operator would look. Two tests in this file used to
 * ASSERT that fallback; they now assert its absence.
 *
 * FIXTURES: synthetic tokens only. Nothing here may look like a real Telegram
 * bot token.
 */

const MASTER_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const OTHER_MASTER_KEY = 'f39fLRkoBAsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiM=';
const TENANT_TOKEN = 'synthetic-tenant-bot-token';
const GLOBAL_TOKEN = 'synthetic-global-bot-token';

const tenantSettingsBase: Omit<TenantSettings, 'telegramBotTokenEncrypted' | 'telegramBotTokenConfigured'> = {
  tenantId: 'tenant_a',
  webhookNotifierUrl: null,
  recipientEmails: [],
  telegramChatIds: [],
  telegramDeliveryMode: 'instant',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function settingsWith(encrypted: TenantEncryptedSecret | null): TenantSettings {
  return {
    ...tenantSettingsBase,
    telegramBotTokenConfigured: Boolean(encrypted),
    telegramBotTokenEncrypted: encrypted,
  };
}

function configWith(overrides: Partial<AppConfigService> = {}): AppConfigService {
  return {
    tenantSecretsMasterKey: MASTER_KEY,
    telegramBotToken: GLOBAL_TOKEN,
    ...overrides,
  } as AppConfigService;
}

/** Ciphertext exactly as the pre-0021 build wrote it: sha256 key, no AAD. */
function encryptLegacyV1(masterKey: string, token: string): TenantEncryptedSecret {
  const key = createHash('sha256').update(masterKey, 'utf8').digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    keyVersion: TENANT_SECRET_KEY_VERSION_LEGACY_SHA256,
  };
}

interface UpgradeCall {
  tenantId: string;
  expected: TenantEncryptedSecret;
  encrypted: TenantEncryptedSecret;
}

type UpgradeMock = jest.Mock<Promise<boolean>, [UpgradeCall]>;

interface ResolverLogger {
  error: jest.Mock<void, [string]>;
  warn: jest.Mock<void, [string]>;
  log: jest.Mock<void, [string]>;
}

function loggerOf(resolver: TelegramBotTokenResolverService): ResolverLogger {
  return (resolver as unknown as { logger: ResolverLogger }).logger;
}

function setup(options: { config?: Partial<AppConfigService>; repository?: Partial<SettingsRepository> } = {}): {
  appConfig: AppConfigService;
  secretService: TenantSecretsService;
  resolver: TelegramBotTokenResolverService;
} {
  const appConfig = configWith(options.config);
  const secretService = new TenantSecretsService(appConfig);
  const resolver = new TelegramBotTokenResolverService(
    appConfig,
    secretService,
    options.repository as SettingsRepository | undefined,
  );

  const logger = loggerOf(resolver);
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'log').mockImplementation(() => undefined);

  return { appConfig, secretService, resolver };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('TelegramBotTokenResolverService', () => {
  it('prefers a decryptable tenant token over the global one', () => {
    const { resolver, secretService } = setup();
    const encrypted = secretService.encryptTelegramBotToken({ tenantId: 'tenant_a', token: TENANT_TOKEN });

    const resolution = resolver.resolveDetailedForTenant({
      tenantId: 'tenant_a',
      settings: settingsWith(encrypted),
    });

    expect(resolution).toEqual({ token: TENANT_TOKEN, source: 'tenant' });
  });

  it('falls back to the global token when the tenant has no settings row', () => {
    const { resolver } = setup();

    expect(resolver.resolveForTenant({ tenantId: 'tenant_a', settings: null })).toBe(GLOBAL_TOKEN);
  });

  it('falls back to the global token when the tenant configured no bot token', () => {
    const { resolver } = setup();

    const resolution = resolver.resolveDetailedForTenant({ tenantId: 'tenant_a', settings: settingsWith(null) });

    expect(resolution).toEqual({ token: GLOBAL_TOKEN, source: 'global' });
  });

  it('reports source none when neither a tenant nor a global token exists', () => {
    const { resolver } = setup({ config: { telegramBotToken: undefined } });

    expect(resolver.resolveDetailedForTenant({ tenantId: 'tenant_a', settings: settingsWith(null) })).toEqual({
      token: undefined,
      source: 'none',
    });
  });
});

describe('TelegramBotTokenResolverService decrypt failures', () => {
  it('does NOT fall back to the global token when the tenant ciphertext is unreadable', () => {
    const { resolver } = setup();

    const resolution = resolver.resolveDetailedForTenant({
      tenantId: 'tenant_a',
      settings: settingsWith({
        ciphertext: 'not-real-ciphertext',
        iv: 'not-a-real-iv',
        tag: 'not-a-real-tag',
        keyVersion: CURRENT_TENANT_SECRET_KEY_VERSION,
      }),
    });

    // Regression guard. This previously returned the global token, which is how
    // a failed key rotation silently sent tenant alerts from the operator's bot.
    expect(resolution.token).toBeUndefined();
    expect(resolution.source).toBe('none');
    expect(resolution.failureReason).toBe('decrypt_failed');
  });

  it('does NOT fall back to the global token when the master key is missing', () => {
    const { secretService } = setup();
    const encrypted = secretService.encryptTelegramBotToken({ tenantId: 'tenant_a', token: TENANT_TOKEN });
    const { resolver } = setup({ config: { tenantSecretsMasterKey: undefined } });

    const resolution = resolver.resolveDetailedForTenant({
      tenantId: 'tenant_a',
      settings: settingsWith(encrypted),
    });

    expect(resolution.token).toBeUndefined();
    expect(resolution.source).toBe('none');
    expect(resolution.failureReason).toBe('master_key_missing');
  });

  it('does NOT fall back to the global token after a master key rotation', () => {
    const { secretService } = setup();
    const encrypted = secretService.encryptTelegramBotToken({ tenantId: 'tenant_a', token: TENANT_TOKEN });
    const { resolver } = setup({ config: { tenantSecretsMasterKey: OTHER_MASTER_KEY } });

    expect(resolver.resolveForTenant({ tenantId: 'tenant_a', settings: settingsWith(encrypted) })).toBeUndefined();
  });

  it('does NOT fall back to the global token for an unknown key version', () => {
    const { resolver, secretService } = setup();
    const encrypted = secretService.encryptTelegramBotToken({ tenantId: 'tenant_a', token: TENANT_TOKEN });

    const resolution = resolver.resolveDetailedForTenant({
      tenantId: 'tenant_a',
      settings: settingsWith({ ...encrypted, keyVersion: 99 }),
    });

    expect(resolution.token).toBeUndefined();
    expect(resolution.failureReason).toBe('unknown_key_version');
  });

  it('logs the failure at error level with the remediation hint', () => {
    const { resolver } = setup();

    resolver.resolveForTenant({
      tenantId: 'tenant_a',
      settings: settingsWith({ ciphertext: 'x', iv: 'y', tag: 'z', keyVersion: CURRENT_TENANT_SECRET_KEY_VERSION }),
    });

    const logger = loggerOf(resolver);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const message = expectDefined(logger.error.mock.calls[0])[0];
    expect(message).toContain('tenant=tenant_a');
    expect(message).toContain('TENANT_SECRETS_MASTER_KEY');
  });
});

describe('TelegramBotTokenResolverService lazy key-version upgrade', () => {
  it('re-encrypts a legacy version-1 token at the current version on first read', async () => {
    const upgrade: UpgradeMock = jest.fn<Promise<boolean>, [UpgradeCall]>().mockResolvedValue(true);
    const { resolver, secretService } = setup({ repository: { upgradeTelegramBotTokenKeyVersion: upgrade } });
    const legacy = encryptLegacyV1(MASTER_KEY, TENANT_TOKEN);

    expect(resolver.resolveForTenant({ tenantId: 'tenant_a', settings: settingsWith(legacy) })).toBe(TENANT_TOKEN);
    await resolver.flushPendingKeyVersionUpgrades();

    expect(upgrade).toHaveBeenCalledTimes(1);
    const call = expectDefined(upgrade.mock.calls[0])[0];
    expect(call.tenantId).toBe('tenant_a');
    expect(call.expected).toEqual(legacy);
    expect(call.encrypted.keyVersion).toBe(CURRENT_TENANT_SECRET_KEY_VERSION);
    // The rewritten blob must be readable, and only as this tenant.
    expect(secretService.decryptTelegramBotToken({ tenantId: 'tenant_a', secret: call.encrypted })).toBe(TENANT_TOKEN);
    expect(() => secretService.decryptTelegramBotToken({ tenantId: 'tenant_b', secret: call.encrypted })).toThrow();
  });

  it('issues one upgrade for a burst of reads of the same tenant', async () => {
    let releaseUpgrade: (value: boolean) => void = () => undefined;
    const upgrade: UpgradeMock = jest.fn<Promise<boolean>, [UpgradeCall]>().mockReturnValue(
      new Promise<boolean>((resolve) => {
        releaseUpgrade = resolve;
      }),
    );
    const { resolver } = setup({ repository: { upgradeTelegramBotTokenKeyVersion: upgrade } });
    const legacy = encryptLegacyV1(MASTER_KEY, TENANT_TOKEN);

    resolver.resolveForTenant({ tenantId: 'tenant_a', settings: settingsWith(legacy) });
    resolver.resolveForTenant({ tenantId: 'tenant_a', settings: settingsWith(legacy) });
    resolver.resolveForTenant({ tenantId: 'tenant_a', settings: settingsWith(legacy) });
    releaseUpgrade(true);
    await resolver.flushPendingKeyVersionUpgrades();

    expect(upgrade).toHaveBeenCalledTimes(1);
  });

  it('does not rewrite a token that is already at the current version', async () => {
    const upgrade: UpgradeMock = jest.fn<Promise<boolean>, [UpgradeCall]>().mockResolvedValue(true);
    const { resolver, secretService } = setup({ repository: { upgradeTelegramBotTokenKeyVersion: upgrade } });
    const current = secretService.encryptTelegramBotToken({ tenantId: 'tenant_a', token: TENANT_TOKEN });

    resolver.resolveForTenant({ tenantId: 'tenant_a', settings: settingsWith(current) });
    await resolver.flushPendingKeyVersionUpgrades();

    expect(upgrade).not.toHaveBeenCalled();
  });

  it('still serves the token when the upgrade write fails', async () => {
    const upgrade: UpgradeMock = jest
      .fn<Promise<boolean>, [UpgradeCall]>()
      .mockRejectedValue(new Error('database_unavailable'));
    const { resolver } = setup({ repository: { upgradeTelegramBotTokenKeyVersion: upgrade } });
    const legacy = encryptLegacyV1(MASTER_KEY, TENANT_TOKEN);

    expect(resolver.resolveForTenant({ tenantId: 'tenant_a', settings: settingsWith(legacy) })).toBe(TENANT_TOKEN);
    await expect(resolver.flushPendingKeyVersionUpgrades()).resolves.toBeUndefined();
    expect(loggerOf(resolver).warn).toHaveBeenCalledTimes(1);
  });

  it('serves legacy tokens unchanged when no repository is wired in', async () => {
    const { resolver } = setup();
    const legacy = encryptLegacyV1(MASTER_KEY, TENANT_TOKEN);

    expect(resolver.resolveForTenant({ tenantId: 'tenant_a', settings: settingsWith(legacy) })).toBe(TENANT_TOKEN);
    await expect(resolver.flushPendingKeyVersionUpgrades()).resolves.toBeUndefined();
  });
});

/**
 * The persistence half of the same feature: the key version has to survive a
 * round trip through `tenant_settings`, and the lazy upgrade has to be safe
 * against a concurrent settings write. These assert on the SQL text and bound
 * parameters, matching `test/rules.repository.spec.ts`, because a shifted `$n`
 * placeholder here would write the wrong tenant's ciphertext.
 */
describe('SettingsRepository telegram bot token key version', () => {
  interface QueryCall {
    sql: string;
    values: unknown[];
  }

  function repositoryWith(result: { rows: unknown[]; rowCount?: number }): {
    calls: QueryCall[];
    repository: SettingsRepository;
  } {
    const calls: QueryCall[] = [];
    const query = jest.fn((sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return Promise.resolve({ rowCount: result.rowCount ?? result.rows.length, ...result });
    });

    return { calls, repository: new SettingsRepository({ query } as never) };
  }

  function settingsRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      tenant_id: 'tenant_a',
      webhook_notifier_url: null,
      recipient_emails: [],
      telegram_chat_ids: [],
      telegram_delivery_mode: 'instant',
      telegram_bot_token_ciphertext: 'cipher',
      telegram_bot_token_iv: 'iv',
      telegram_bot_token_tag: 'tag',
      telegram_bot_token_key_version: 2,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    };
  }

  it('surfaces the stored key version on read', async () => {
    const { repository } = repositoryWith({ rows: [settingsRow()] });

    const settings = await repository.getByTenantId('tenant_a');

    expect(settings?.telegramBotTokenEncrypted?.keyVersion).toBe(CURRENT_TENANT_SECRET_KEY_VERSION);
  });

  it('reads a row from a pre-0021 schema as legacy version 1', async () => {
    const { repository } = repositoryWith({
      rows: [settingsRow({ telegram_bot_token_key_version: undefined })],
    });

    const settings = await repository.getByTenantId('tenant_a');

    expect(settings?.telegramBotTokenEncrypted?.keyVersion).toBe(TENANT_SECRET_KEY_VERSION_LEGACY_SHA256);
  });

  it('persists the key version alongside the ciphertext on set', async () => {
    const { repository, calls } = repositoryWith({ rows: [settingsRow()] });

    await repository.upsertNotifierSettings({
      tenantId: 'tenant_a',
      webhookNotifierUrl: null,
      recipientEmails: [],
      telegramChatIds: [],
      telegramDeliveryMode: 'instant',
      telegramBotTokenOperation: 'set',
      telegramBotTokenEncrypted: { ciphertext: 'c', iv: 'i', tag: 't', keyVersion: 2 },
    });

    const call = calls[0];
    expect(call?.sql).toContain('telegram_bot_token_key_version');
    expect(call?.values[9]).toBe(2);
  });

  it('rewrites the ciphertext in place, pinned to the version it read', async () => {
    const { repository, calls } = repositoryWith({ rows: [], rowCount: 1 });

    const upgraded = await repository.upgradeTelegramBotTokenKeyVersion({
      tenantId: 'tenant_a',
      expected: { ciphertext: 'old', iv: 'oldiv', tag: 'oldtag', keyVersion: 1 },
      encrypted: { ciphertext: 'new', iv: 'newiv', tag: 'newtag', keyVersion: 2 },
    });

    expect(upgraded).toBe(true);
    const call = calls[0];
    expect(call?.sql).toMatch(/WHERE\s+tenant_id = \$1/);
    expect(call?.sql).toMatch(/AND\s+telegram_bot_token_ciphertext = \$6/);
    expect(call?.sql).toMatch(/AND\s+telegram_bot_token_key_version = \$7/);
    // A storage-format rewrite must not look like an operator edit.
    expect(call?.sql).not.toContain('updated_at');
    expect(call?.values).toEqual(['tenant_a', 'new', 'newiv', 'newtag', 2, 'old', 1]);
  });

  it('reports a lost race as not upgraded', async () => {
    const { repository } = repositoryWith({ rows: [], rowCount: 0 });

    await expect(
      repository.upgradeTelegramBotTokenKeyVersion({
        tenantId: 'tenant_a',
        expected: { ciphertext: 'old', iv: 'oldiv', tag: 'oldtag', keyVersion: 1 },
        encrypted: { ciphertext: 'new', iv: 'newiv', tag: 'newtag', keyVersion: 2 },
      }),
    ).resolves.toBe(false);
  });
});
