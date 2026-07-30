import { Injectable, Logger, Optional } from '@nestjs/common';
import { Counter } from 'prom-client';
import { AppConfigService } from '../../shared/config/app-config.service';
import { SHARED_METRICS_REGISTRY } from '../observability/metrics-registry';
import { SettingsRepository, TenantEncryptedSecret, TenantSettings } from './settings.repository';
import {
  TenantSecretDecryptError,
  TenantSecretFailureReason,
  TenantSecretsMasterKeyMissingError,
  TenantSecretsService,
} from './tenant-secrets.service';

/**
 * Where the Telegram bot token used for a tenant came from.
 *
 * `none` is the important one: it means the tenant HAS a token configured but
 * it could not be opened. Reporting that as `global` is what made a botched
 * master-key rotation silently reroute every tenant's Telegram traffic through
 * the operator's own bot.
 */
export type TelegramBotTokenSource = 'tenant' | 'global' | 'none';

export interface TelegramBotTokenResolution {
  readonly token: string | undefined;
  readonly source: TelegramBotTokenSource;
  readonly failureReason?: TenantSecretFailureReason;
}

const DECRYPT_FAILURE_COUNTER_NAME = 'rss_tenant_secret_decrypt_failures_total';

function getOrCreateDecryptFailureCounter(): Counter<'secret' | 'reason'> {
  const existing = SHARED_METRICS_REGISTRY.getSingleMetric(DECRYPT_FAILURE_COUNTER_NAME);
  if (existing) {
    return existing as Counter<'secret' | 'reason'>;
  }

  return new Counter({
    name: DECRYPT_FAILURE_COUNTER_NAME,
    help: 'Tenant secrets that exist in the database but could not be decrypted',
    labelNames: ['secret', 'reason'] as const,
    registers: [SHARED_METRICS_REGISTRY],
  });
}

const decryptFailuresTotal = getOrCreateDecryptFailureCounter();

function classifyFailure(error: unknown): TenantSecretFailureReason {
  if (error instanceof TenantSecretsMasterKeyMissingError || error instanceof TenantSecretDecryptError) {
    return error.reason;
  }

  return 'decrypt_failed';
}

@Injectable()
export class TelegramBotTokenResolverService {
  private readonly logger = new Logger(TelegramBotTokenResolverService.name);
  /** Tenant -> in-flight key-version upgrade, so a burst of alerts issues one UPDATE. */
  private readonly pendingKeyVersionUpgrades = new Map<string, Promise<void>>();

  constructor(
    private readonly appConfigService: AppConfigService,
    private readonly tenantSecretsService: TenantSecretsService,
    /**
     * Optional so the resolver stays constructible in isolation. When present
     * (the normal DI path) a legacy-key-version ciphertext is rewritten under
     * the current key the first time it is read, which is what makes migration
     * 0021 a zero-touch upgrade for the operator.
     */
    @Optional() private readonly settingsRepository?: SettingsRepository,
  ) {}

  resolveForTenant(input: { tenantId: string; settings: TenantSettings | null }): string | undefined {
    return this.resolveDetailedForTenant(input).token;
  }

  /**
   * Resolution rules, in order:
   *
   *  1. No tenant ciphertext -> the global `TELEGRAM_BOT_TOKEN`. This is the
   *     ordinary "tenant has not configured its own bot" case.
   *  2. Tenant ciphertext that opens -> the tenant token.
   *  3. Tenant ciphertext that does NOT open -> NOTHING. Never the global token:
   *     the tenant explicitly asked for its own bot, and answering with the
   *     operator's bot would push that tenant's alerts into Telegram under the
   *     wrong identity. Callers gate on `isTelegramEnabled`, so an undefined
   *     token means "skip Telegram for this tenant", while the error log and
   *     `rss_tenant_secret_decrypt_failures_total` make the misconfiguration
   *     loud instead of invisible.
   */
  resolveDetailedForTenant(input: { tenantId: string; settings: TenantSettings | null }): TelegramBotTokenResolution {
    const encrypted = input.settings?.telegramBotTokenEncrypted;

    if (!encrypted) {
      const globalToken = this.appConfigService.telegramBotToken;
      return { token: globalToken, source: globalToken ? 'global' : 'none' };
    }

    try {
      const token = this.tenantSecretsService.decryptTelegramBotToken({
        tenantId: input.tenantId,
        secret: encrypted,
      });

      if (this.tenantSecretsService.needsKeyVersionUpgrade(encrypted)) {
        this.scheduleKeyVersionUpgrade(input.tenantId, encrypted, token);
      }

      return { token, source: 'tenant' };
    } catch (error) {
      const reason = classifyFailure(error);
      decryptFailuresTotal.inc({ secret: 'telegram_bot_token', reason });
      this.logger.error(
        `Tenant telegram bot token could not be decrypted tenant=${input.tenantId} reason=${reason} ` +
          `keyVersion=${encrypted.keyVersion}. Telegram delivery is DISABLED for this tenant; ` +
          'the global bot token is deliberately not used as a fallback. ' +
          'Check TENANT_SECRETS_MASTER_KEY, or have the tenant re-save its bot token.',
      );

      return { token: undefined, source: 'none', failureReason: reason };
    }
  }

  /**
   * Awaits any lazy re-encryption started by `resolveDetailedForTenant`.
   * Exposed for tests and for orderly shutdown; the read path never blocks on
   * it.
   */
  async flushPendingKeyVersionUpgrades(): Promise<void> {
    await Promise.all([...this.pendingKeyVersionUpgrades.values()]);
  }

  private scheduleKeyVersionUpgrade(tenantId: string, previous: TenantEncryptedSecret, plaintext: string): void {
    const repository = this.settingsRepository;
    if (!repository || this.pendingKeyVersionUpgrades.has(tenantId)) {
      return;
    }

    const upgrade = this.upgradeKeyVersion(repository, tenantId, previous, plaintext).finally(() => {
      this.pendingKeyVersionUpgrades.delete(tenantId);
    });

    this.pendingKeyVersionUpgrades.set(tenantId, upgrade);
  }

  private async upgradeKeyVersion(
    repository: SettingsRepository,
    tenantId: string,
    previous: TenantEncryptedSecret,
    plaintext: string,
  ): Promise<void> {
    try {
      const encrypted = this.tenantSecretsService.encryptTelegramBotToken({ tenantId, token: plaintext });
      const upgraded = await repository.upgradeTelegramBotTokenKeyVersion({ tenantId, expected: previous, encrypted });

      if (upgraded) {
        this.logger.log(
          `Re-encrypted tenant telegram bot token tenant=${tenantId} ` +
            `fromKeyVersion=${previous.keyVersion} toKeyVersion=${encrypted.keyVersion}`,
        );
      }
    } catch (error) {
      // Non-fatal: the stored ciphertext is untouched and still opens under its
      // old key version, so the next read simply tries again.
      const message = error instanceof Error ? error.message : 'unknown_error';
      this.logger.warn(
        `Could not re-encrypt tenant telegram bot token tenant=${tenantId} reason=${message}. ` +
          'The existing ciphertext is untouched and will be retried on the next read.',
      );
    }
  }
}
