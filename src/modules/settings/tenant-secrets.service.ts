import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { AppConfigService } from '../../shared/config/app-config.service';
import { TenantEncryptedSecret } from './settings.repository';

/**
 * Envelope encryption for per-tenant secrets (today: the Telegram bot token).
 *
 * The cipher is AES-256-GCM with a fresh 12-byte IV per encryption and the auth
 * tag stored alongside the ciphertext. Two properties beyond the raw cipher
 * matter here, and both are versioned by `keyVersion` so that ciphertext written
 * by an older build stays readable:
 *
 *   version 1 (legacy) - key = unsalted `sha256(TENANT_SECRETS_MASTER_KEY)`, no
 *     AAD. A single SHA-256 pass is not a KDF: an operator passphrase such as
 *     `changeme` is brute-forceable offline at hashing speed if the database
 *     leaks. And with no AAD a ciphertext blob is portable between tenant rows,
 *     so anyone with database write access could move tenant A's token onto
 *     tenant B. Kept ONLY so rows written before migration 0021 still decrypt.
 *
 *   version 2 (current) - key = `scrypt(masterKey, SCRYPT_SALT, 32)` with
 *     memory-hard parameters, and the GCM AAD binds the ciphertext to the
 *     owning `tenant_id`. Moving the blob to another tenant row now fails
 *     authentication instead of silently decrypting.
 *
 * The scrypt salt is a fixed application-wide domain-separation constant rather
 * than a per-row random value on purpose: the derived key is cached per process,
 * and a per-row salt would force a ~100 ms scrypt run on every alert delivery.
 * The master key is expected to carry the entropy (see
 * `isWeakTenantSecretsMasterKey` and the `TENANT_SECRETS_MASTER_KEY` validation
 * in the env schema); scrypt is defence in depth for when it does not.
 */
const CIPHER_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const DERIVED_KEY_LENGTH_BYTES = 32;

/** Unsalted `sha256(masterKey)`, no AAD. Pre-0021 rows only. */
export const TENANT_SECRET_KEY_VERSION_LEGACY_SHA256 = 1;
/** scrypt-derived key + AES-256-GCM AAD bound to `tenant_id`. */
export const TENANT_SECRET_KEY_VERSION_SCRYPT_AAD = 2;
/** The version every new ciphertext is written at. */
export const CURRENT_TENANT_SECRET_KEY_VERSION = TENANT_SECRET_KEY_VERSION_SCRYPT_AAD;

const SUPPORTED_KEY_VERSIONS: ReadonlySet<number> = new Set([
  TENANT_SECRET_KEY_VERSION_LEGACY_SHA256,
  TENANT_SECRET_KEY_VERSION_SCRYPT_AAD,
]);

const SCRYPT_SALT = Buffer.from('feedpulse.tenant-secrets.kdf.v2', 'utf8');
const SCRYPT_COST = 32768;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
/** scrypt needs ~`128 * N * r` bytes (32 MiB here); Node's default cap is 32 MiB exactly. */
const SCRYPT_MAX_MEMORY_BYTES = 96 * 1024 * 1024;

/** Minimum master-key material before the service starts complaining. */
export const MIN_TENANT_SECRETS_MASTER_KEY_BYTES = 32;

const KNOWN_WEAK_MASTER_KEYS: ReadonlySet<string> = new Set([
  'change-me',
  'changeme',
  'default',
  'dev',
  'development',
  'feedpulse',
  'local',
  'master',
  'master_key',
  'master_test',
  'password',
  'secret',
  'test',
]);

const BASE64_LIKE = /^[A-Za-z0-9+/\-_]+={0,2}$/;

/**
 * Process-wide cache of derived keys. scrypt at these parameters costs ~100 ms
 * and the Telegram resolver runs on the alert-delivery hot path.
 */
const derivedKeyCache = new Map<string, Buffer>();
const DERIVED_KEY_CACHE_LIMIT = 8;

/** Master keys already reported as weak, so the warning is logged once each. */
const weakMasterKeysReported = new Set<string>();

export type TenantSecretFailureReason = 'master_key_missing' | 'unknown_key_version' | 'decrypt_failed';

/**
 * Thrown when `TENANT_SECRETS_MASTER_KEY` is not configured.
 *
 * Stays a `BadRequestException` because the settings write path surfaces it
 * directly to the operator, but gets its own class so the read path can tell
 * "not configured" apart from "configured, but this ciphertext will not open" -
 * the two demand very different operator responses.
 */
export class TenantSecretsMasterKeyMissingError extends BadRequestException {
  readonly reason: TenantSecretFailureReason = 'master_key_missing';

  constructor() {
    super('tenant_secrets_master_key_missing');
  }
}

/** Thrown when stored ciphertext exists but cannot be authenticated or opened. */
export class TenantSecretDecryptError extends Error {
  constructor(
    message: string,
    readonly reason: TenantSecretFailureReason,
  ) {
    super(message);
    this.name = 'TenantSecretDecryptError';
  }
}

/**
 * Heuristic guard against operator passphrases. `openssl rand -base64 32`
 * produces a 44-character string that decodes to 32 bytes and passes; a
 * memorable word does not.
 */
export function isWeakTenantSecretsMasterKey(masterKey: string): boolean {
  const normalized = masterKey.trim();
  if (normalized.length === 0) {
    return true;
  }

  if (KNOWN_WEAK_MASTER_KEYS.has(normalized.toLowerCase())) {
    return true;
  }

  const decodedBytes = BASE64_LIKE.test(normalized) ? Buffer.from(normalized, 'base64').length : 0;
  const rawBytes = Buffer.byteLength(normalized, 'utf8');

  return Math.max(decodedBytes, rawBytes) < MIN_TENANT_SECRETS_MASTER_KEY_BYTES;
}

function buildAdditionalAuthenticatedData(tenantId: string): Buffer {
  return Buffer.from(`feedpulse:telegram_bot_token:${tenantId}`, 'utf8');
}

function requireTenantId(tenantId: string): string {
  if (!tenantId) {
    throw new BadRequestException('tenant_secrets_tenant_id_required');
  }

  return tenantId;
}

function cacheDerivedKey(cacheKey: string, key: Buffer): Buffer {
  if (derivedKeyCache.size >= DERIVED_KEY_CACHE_LIMIT) {
    derivedKeyCache.clear();
  }

  derivedKeyCache.set(cacheKey, key);
  return key;
}

@Injectable()
export class TenantSecretsService {
  private readonly logger = new Logger(TenantSecretsService.name);

  constructor(private readonly appConfigService: AppConfigService) {}

  canUseTenantSecrets(): boolean {
    return Boolean(this.appConfigService.tenantSecretsMasterKey);
  }

  encryptTelegramBotToken(input: { tenantId: string; token: string }): TenantEncryptedSecret {
    const tenantId = requireTenantId(input.tenantId);
    if (!input.token) {
      throw new BadRequestException('tenant_telegram_token_empty');
    }

    const key = this.getDerivedMasterKeyOrThrow(CURRENT_TENANT_SECRET_KEY_VERSION);
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(CIPHER_ALGORITHM, key, iv);
    cipher.setAAD(buildAdditionalAuthenticatedData(tenantId));
    const ciphertext = Buffer.concat([cipher.update(input.token, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      keyVersion: CURRENT_TENANT_SECRET_KEY_VERSION,
    };
  }

  decryptTelegramBotToken(input: { tenantId: string; secret: TenantEncryptedSecret }): string {
    const tenantId = requireTenantId(input.tenantId);
    const keyVersion = input.secret.keyVersion ?? TENANT_SECRET_KEY_VERSION_LEGACY_SHA256;

    if (!SUPPORTED_KEY_VERSIONS.has(keyVersion)) {
      throw new TenantSecretDecryptError(`tenant_secrets_unknown_key_version:${keyVersion}`, 'unknown_key_version');
    }

    const key = this.getDerivedMasterKeyOrThrow(keyVersion);

    let plaintext: string;
    try {
      const decipher = createDecipheriv(CIPHER_ALGORITHM, key, Buffer.from(input.secret.iv, 'base64'));
      if (keyVersion === TENANT_SECRET_KEY_VERSION_SCRYPT_AAD) {
        decipher.setAAD(buildAdditionalAuthenticatedData(tenantId));
      }
      decipher.setAuthTag(Buffer.from(input.secret.tag, 'base64'));
      plaintext = Buffer.concat([
        decipher.update(Buffer.from(input.secret.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Deliberately opaque: a caller must not be able to tell a wrong key from
      // a tampered tag from another tenant's blob.
      throw new TenantSecretDecryptError('tenant_telegram_token_decrypt_failed', 'decrypt_failed');
    }

    if (!plaintext) {
      throw new TenantSecretDecryptError('tenant_telegram_token_empty_after_decrypt', 'decrypt_failed');
    }

    return plaintext;
  }

  /** True when the stored ciphertext predates the current key version. */
  needsKeyVersionUpgrade(secret: TenantEncryptedSecret): boolean {
    return (secret.keyVersion ?? TENANT_SECRET_KEY_VERSION_LEGACY_SHA256) !== CURRENT_TENANT_SECRET_KEY_VERSION;
  }

  /**
   * Decrypt-old / encrypt-new. Returns `null` when the secret is already at the
   * current version, so callers can invoke it unconditionally.
   */
  reencryptTelegramBotToken(input: { tenantId: string; secret: TenantEncryptedSecret }): TenantEncryptedSecret | null {
    if (!this.needsKeyVersionUpgrade(input.secret)) {
      return null;
    }

    const plaintext = this.decryptTelegramBotToken(input);
    return this.encryptTelegramBotToken({ tenantId: input.tenantId, token: plaintext });
  }

  private getDerivedMasterKeyOrThrow(keyVersion: number): Buffer {
    const masterKey = this.appConfigService.tenantSecretsMasterKey;
    if (!masterKey) {
      throw new TenantSecretsMasterKeyMissingError();
    }

    const masterKeyFingerprint = createHash('sha256').update(masterKey, 'utf8').digest('hex');
    const cacheKey = `${keyVersion}:${masterKeyFingerprint}`;
    const cached = derivedKeyCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    this.warnOnceIfWeak(masterKey, masterKeyFingerprint);

    if (keyVersion === TENANT_SECRET_KEY_VERSION_LEGACY_SHA256) {
      return cacheDerivedKey(cacheKey, createHash('sha256').update(masterKey, 'utf8').digest());
    }

    return cacheDerivedKey(
      cacheKey,
      scryptSync(masterKey, SCRYPT_SALT, DERIVED_KEY_LENGTH_BYTES, {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION,
        maxmem: SCRYPT_MAX_MEMORY_BYTES,
      }),
    );
  }

  private warnOnceIfWeak(masterKey: string, masterKeyFingerprint: string): void {
    if (weakMasterKeysReported.has(masterKeyFingerprint) || !isWeakTenantSecretsMasterKey(masterKey)) {
      return;
    }

    weakMasterKeysReported.add(masterKeyFingerprint);
    this.logger.warn(
      'TENANT_SECRETS_MASTER_KEY carries less than 32 bytes of material or is a known placeholder. ' +
        'Tenant secrets are only as strong as this key - regenerate it with `openssl rand -base64 32` ' +
        'and re-save every tenant Telegram bot token.',
    );
  }
}
