import { BadRequestException } from '@nestjs/common';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import type { TenantEncryptedSecret } from '../src/modules/settings/settings.repository';
import {
  CURRENT_TENANT_SECRET_KEY_VERSION,
  isWeakTenantSecretsMasterKey,
  TENANT_SECRET_KEY_VERSION_LEGACY_SHA256,
  TENANT_SECRET_KEY_VERSION_SCRYPT_AAD,
  TenantSecretDecryptError,
  TenantSecretsMasterKeyMissingError,
  TenantSecretsService,
} from '../src/modules/settings/tenant-secrets.service';
import type { AppConfigService } from '../src/shared/config/app-config.service';

/**
 * The crypto contract for per-tenant secrets.
 *
 * Everything here is about properties the cipher choice is supposed to buy and
 * that nothing previously checked: that a tampered blob is REJECTED rather than
 * decrypted to garbage (the entire point of GCM over CBC), that no two
 * encryptions of the same plaintext collide (fresh IV), and that a blob cannot
 * be lifted from one tenant row onto another (AAD binding).
 *
 * FIXTURES: every token here is obviously synthetic. Do not paste anything
 * shaped like a real Telegram bot token (`<digits>:<35 chars>`) into this file -
 * secret scanners flag the repository, and the tests do not need realism.
 */

/** 32 bytes of base64, the shape `openssl rand -base64 32` produces. */
const MASTER_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const OTHER_MASTER_KEY = 'f39fLRkoBAsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiM=';

const SYNTHETIC_TOKEN = 'synthetic-not-a-real-bot-token';

function configWith(masterKey: string | undefined): AppConfigService {
  return { tenantSecretsMasterKey: masterKey } as AppConfigService;
}

function serviceWith(masterKey: string | undefined): TenantSecretsService {
  return new TenantSecretsService(configWith(masterKey));
}

/**
 * Produces a ciphertext exactly the way the pre-0021 implementation did:
 * unsalted `sha256(masterKey)` as the key and NO additional authenticated data.
 * Rows written by that build are still in production databases, so this is the
 * fixture that proves migration 0021 does not orphan them.
 */
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

function flipLastBase64Byte(value: string): string {
  const bytes = Buffer.from(value, 'base64');
  const lastIndex = bytes.length - 1;
  bytes[lastIndex] = (bytes[lastIndex] ?? 0) ^ 0x01;
  return bytes.toString('base64');
}

describe('TenantSecretsService round trip', () => {
  it.each([
    ['ascii', SYNTHETIC_TOKEN],
    ['unicode', 'ficha-señal-🔐-Ω-токен'],
    ['single character', 'x'],
    ['long', 'z'.repeat(4096)],
  ])('preserves a %s token exactly', (_label, token) => {
    const service = serviceWith(MASTER_KEY);

    const secret = service.encryptTelegramBotToken({ tenantId: 'tenant_a', token });

    expect(service.decryptTelegramBotToken({ tenantId: 'tenant_a', secret })).toBe(token);
  });

  it('stamps new ciphertext with the current key version', () => {
    const secret = serviceWith(MASTER_KEY).encryptTelegramBotToken({ tenantId: 'tenant_a', token: SYNTHETIC_TOKEN });

    expect(secret.keyVersion).toBe(CURRENT_TENANT_SECRET_KEY_VERSION);
    expect(CURRENT_TENANT_SECRET_KEY_VERSION).toBe(TENANT_SECRET_KEY_VERSION_SCRYPT_AAD);
  });

  it('never emits the plaintext in any stored field', () => {
    const secret = serviceWith(MASTER_KEY).encryptTelegramBotToken({ tenantId: 'tenant_a', token: SYNTHETIC_TOKEN });

    expect(`${secret.ciphertext}${secret.iv}${secret.tag}`).not.toContain(SYNTHETIC_TOKEN);
  });

  it('produces a different ciphertext and IV every time (fresh IV, no reuse)', () => {
    const service = serviceWith(MASTER_KEY);

    const first = service.encryptTelegramBotToken({ tenantId: 'tenant_a', token: SYNTHETIC_TOKEN });
    const second = service.encryptTelegramBotToken({ tenantId: 'tenant_a', token: SYNTHETIC_TOKEN });

    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(service.decryptTelegramBotToken({ tenantId: 'tenant_a', secret: second })).toBe(SYNTHETIC_TOKEN);
  });
});

describe('TenantSecretsService authentication', () => {
  const service = serviceWith(MASTER_KEY);
  const secret = service.encryptTelegramBotToken({ tenantId: 'tenant_a', token: SYNTHETIC_TOKEN });

  it('rejects a tampered ciphertext instead of returning garbage', () => {
    expect(() =>
      service.decryptTelegramBotToken({
        tenantId: 'tenant_a',
        secret: { ...secret, ciphertext: flipLastBase64Byte(secret.ciphertext) },
      }),
    ).toThrow(TenantSecretDecryptError);
  });

  it('rejects a tampered auth tag', () => {
    expect(() =>
      service.decryptTelegramBotToken({
        tenantId: 'tenant_a',
        secret: { ...secret, tag: flipLastBase64Byte(secret.tag) },
      }),
    ).toThrow(TenantSecretDecryptError);
  });

  it('rejects a tampered IV', () => {
    expect(() =>
      service.decryptTelegramBotToken({
        tenantId: 'tenant_a',
        secret: { ...secret, iv: flipLastBase64Byte(secret.iv) },
      }),
    ).toThrow(TenantSecretDecryptError);
  });

  it('rejects a ciphertext moved onto another tenant row (AAD binding)', () => {
    // The threat: anyone with database write access copies tenant A's three
    // encrypted columns onto tenant B's row and starts receiving A's alerts
    // through A's bot. The AAD makes that blob unopenable as tenant B.
    expect(() => service.decryptTelegramBotToken({ tenantId: 'tenant_b', secret })).toThrow(TenantSecretDecryptError);
  });

  it('rejects a ciphertext written under a different master key', () => {
    const other = serviceWith(OTHER_MASTER_KEY);

    expect(() => other.decryptTelegramBotToken({ tenantId: 'tenant_a', secret })).toThrow(TenantSecretDecryptError);
  });

  it('rejects a key version it does not know how to open', () => {
    expect(() =>
      service.decryptTelegramBotToken({ tenantId: 'tenant_a', secret: { ...secret, keyVersion: 99 } }),
    ).toThrow(TenantSecretDecryptError);

    try {
      service.decryptTelegramBotToken({ tenantId: 'tenant_a', secret: { ...secret, keyVersion: 99 } });
      throw new Error('expected decryption to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TenantSecretDecryptError);
      expect((error as TenantSecretDecryptError).reason).toBe('unknown_key_version');
    }
  });
});

describe('TenantSecretsService guards', () => {
  it('throws tenant_secrets_master_key_missing from encrypt when no master key is configured', () => {
    const service = serviceWith(undefined);

    expect(() => service.encryptTelegramBotToken({ tenantId: 'tenant_a', token: SYNTHETIC_TOKEN })).toThrow(
      TenantSecretsMasterKeyMissingError,
    );
    expect(() => service.encryptTelegramBotToken({ tenantId: 'tenant_a', token: SYNTHETIC_TOKEN })).toThrow(
      'tenant_secrets_master_key_missing',
    );
  });

  it('throws tenant_secrets_master_key_missing from decrypt when no master key is configured', () => {
    const secret = serviceWith(MASTER_KEY).encryptTelegramBotToken({ tenantId: 'tenant_a', token: SYNTHETIC_TOKEN });
    const service = serviceWith(undefined);

    expect(() => service.decryptTelegramBotToken({ tenantId: 'tenant_a', secret })).toThrow(
      TenantSecretsMasterKeyMissingError,
    );
    expect(() => service.decryptTelegramBotToken({ tenantId: 'tenant_a', secret })).toThrow(
      'tenant_secrets_master_key_missing',
    );
  });

  it('keeps the missing master key a BadRequestException for the HTTP write path', () => {
    expect(() => serviceWith(undefined).encryptTelegramBotToken({ tenantId: 'tenant_a', token: 't' })).toThrow(
      BadRequestException,
    );
  });

  it('refuses to encrypt an empty token', () => {
    expect(() => serviceWith(MASTER_KEY).encryptTelegramBotToken({ tenantId: 'tenant_a', token: '' })).toThrow(
      'tenant_telegram_token_empty',
    );
  });

  it('refuses to encrypt or decrypt without a tenant id', () => {
    const service = serviceWith(MASTER_KEY);
    const secret = service.encryptTelegramBotToken({ tenantId: 'tenant_a', token: SYNTHETIC_TOKEN });

    expect(() => service.encryptTelegramBotToken({ tenantId: '', token: SYNTHETIC_TOKEN })).toThrow(
      'tenant_secrets_tenant_id_required',
    );
    expect(() => service.decryptTelegramBotToken({ tenantId: '', secret })).toThrow(
      'tenant_secrets_tenant_id_required',
    );
  });

  it('reports a decrypted-but-empty plaintext rather than returning it', () => {
    // Reachable only if something outside the service wrote an authenticated
    // empty payload; the guard exists so an empty token can never be handed to
    // the Telegram client as if it were valid.
    const service = serviceWith(MASTER_KEY);
    // A legitimately authenticated blob whose plaintext is the empty string.
    const emptySecret = encryptLegacyV1(MASTER_KEY, '');
    expect(() => service.decryptTelegramBotToken({ tenantId: 'tenant_a', secret: emptySecret })).toThrow(
      'tenant_telegram_token_empty_after_decrypt',
    );
  });
});

describe('TenantSecretsService key versioning', () => {
  it('still decrypts a legacy version-1 ciphertext written before migration 0021', () => {
    const service = serviceWith(MASTER_KEY);
    const legacy = encryptLegacyV1(MASTER_KEY, SYNTHETIC_TOKEN);

    expect(service.decryptTelegramBotToken({ tenantId: 'tenant_a', secret: legacy })).toBe(SYNTHETIC_TOKEN);
  });

  it('treats a secret with no recorded version as legacy version 1', () => {
    const service = serviceWith(MASTER_KEY);
    const legacy = encryptLegacyV1(MASTER_KEY, SYNTHETIC_TOKEN);
    const withoutVersion = { ...legacy, keyVersion: undefined } as unknown as TenantEncryptedSecret;

    expect(service.decryptTelegramBotToken({ tenantId: 'tenant_a', secret: withoutVersion })).toBe(SYNTHETIC_TOKEN);
    expect(service.needsKeyVersionUpgrade(withoutVersion)).toBe(true);
  });

  it('does NOT bind the legacy scheme to a tenant - which is precisely why version 2 exists', () => {
    const service = serviceWith(MASTER_KEY);
    const legacy = encryptLegacyV1(MASTER_KEY, SYNTHETIC_TOKEN);

    // A version-1 blob opens under any tenant id. Documented, not endorsed:
    // it is the portability hole the AAD in version 2 closes.
    expect(service.decryptTelegramBotToken({ tenantId: 'tenant_b', secret: legacy })).toBe(SYNTHETIC_TOKEN);
  });

  it('re-encrypts a legacy secret at the current version, tenant-bound', () => {
    const service = serviceWith(MASTER_KEY);
    const legacy = encryptLegacyV1(MASTER_KEY, SYNTHETIC_TOKEN);

    const upgraded = service.reencryptTelegramBotToken({ tenantId: 'tenant_a', secret: legacy });

    expect(upgraded).not.toBeNull();
    expect(upgraded?.keyVersion).toBe(CURRENT_TENANT_SECRET_KEY_VERSION);
    expect(upgraded?.ciphertext).not.toBe(legacy.ciphertext);
    expect(service.decryptTelegramBotToken({ tenantId: 'tenant_a', secret: upgraded as TenantEncryptedSecret })).toBe(
      SYNTHETIC_TOKEN,
    );
    // The upgrade is what buys the tenant binding.
    expect(() =>
      service.decryptTelegramBotToken({ tenantId: 'tenant_b', secret: upgraded as TenantEncryptedSecret }),
    ).toThrow(TenantSecretDecryptError);
  });

  it('returns null instead of churning a secret that is already current', () => {
    const service = serviceWith(MASTER_KEY);
    const current = service.encryptTelegramBotToken({ tenantId: 'tenant_a', token: SYNTHETIC_TOKEN });

    expect(service.needsKeyVersionUpgrade(current)).toBe(false);
    expect(service.reencryptTelegramBotToken({ tenantId: 'tenant_a', secret: current })).toBeNull();
  });
});

describe('canUseTenantSecrets', () => {
  it('is false without a master key and true with one', () => {
    expect(serviceWith(undefined).canUseTenantSecrets()).toBe(false);
    expect(serviceWith(MASTER_KEY).canUseTenantSecrets()).toBe(true);
  });
});

describe('isWeakTenantSecretsMasterKey', () => {
  it.each(['', '   ', 'changeme', 'CHANGEME', 'secret', 'master_test', 'short-passphrase'])(
    'rejects %p',
    (candidate) => {
      expect(isWeakTenantSecretsMasterKey(candidate)).toBe(true);
    },
  );

  it('accepts 32 bytes of base64, the documented generation recipe', () => {
    expect(isWeakTenantSecretsMasterKey(MASTER_KEY)).toBe(false);
    expect(isWeakTenantSecretsMasterKey(randomBytes(32).toString('base64'))).toBe(false);
  });

  it('accepts a long non-base64 passphrase carrying at least 32 bytes', () => {
    expect(isWeakTenantSecretsMasterKey('correct horse battery staple correct horse')).toBe(false);
  });
});
