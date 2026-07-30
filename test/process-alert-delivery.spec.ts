import { Logger } from '@nestjs/common';
import { ProcessAlertDeliveryUseCase } from '../src/modules/alerts/application/process-alert-delivery.use-case';

/**
 * Per-channel delivery semantics of `ProcessAlertDeliveryUseCase`.
 *
 * The correctness of this use case is mostly about what it does NOT do. Once
 * migration 0013 gave every alert a per-channel status, a retry must re-attempt
 * only the channels that are still pending: re-sending a channel already marked
 * `sent` means the reader receives the same article twice, which is exactly the
 * failure mode the aggregation work was meant to remove.
 *
 * Every double is a plain object injected manually; no Nest container is booted.
 */

type ChannelStatus = 'pending' | 'sent' | 'failed';

interface SetupOptions {
  webhookStatus?: ChannelStatus;
  telegramStatus?: ChannelStatus;
  emailStatus?: ChannelStatus;
  webhookNotifierUrl?: string | null;
  configuredWebhookNotifierUrl?: string | null;
  recipientEmails?: string[];
  telegramChatIds?: string[];
  telegramDeliveryMode?: 'instant' | 'digest_10m';
  tenantSettings?: null;
  notifierEnabled?: boolean;
  emailEnabled?: boolean;
  telegramEnabled?: boolean;
  allDelivered?: boolean;
  markSentReturns?: boolean;
  /** Quota decision returned by the email rate limiter for this alert. */
  emailQuota?: { allowed: boolean; limit: number; used: number; degraded: boolean };
  /** Drop `incrementAlertDeliveryChannelFailure` to emulate a MetricsService without it. */
  withoutChannelFailureMetric?: boolean;
  sendWebhook?: jest.Mock;
  sendEmail?: jest.Mock;
  sendTelegram?: jest.Mock;
}

function setup(options: SetupOptions = {}) {
  const alert = {
    id: '1',
    tenantId: 'tenant-x',
    sent: false,
    sentAt: null,
    deliveryStatus: 'queued' as const,
    deliveryAttempts: 0,
    lastDeliveryAttemptAt: null,
    lastDeliveryError: null,
    lastDeliveryQueuedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    matchedRules: [1],
    webhookDeliveryStatus: options.webhookStatus ?? 'pending',
    telegramDeliveryStatus: options.telegramStatus ?? 'pending',
    emailDeliveryStatus: options.emailStatus ?? 'pending',
    entry: { id: 'e1', title: 'Title', link: 'https://example.com/a', content: 'Body' },
    rule: { id: 1, name: 'Rule', includeKeywords: [], excludeKeywords: [] },
  };

  const alertsRepository = {
    findByIdForWorker: jest.fn().mockResolvedValue(alert),
    markDeliveryDisabled: jest.fn().mockResolvedValue(undefined),
    markChannelDelivered: jest.fn().mockResolvedValue(undefined),
    markChannelFailed: jest.fn().mockResolvedValue(undefined),
    checkAllChannelsDelivered: jest.fn().mockResolvedValue({ allDelivered: options.allDelivered ?? true }),
    markSent: jest.fn().mockResolvedValue(options.markSentReturns ?? true),
    markDeliveryRetryPending: jest.fn().mockResolvedValue(undefined),
    markDeliveryFailure: jest.fn().mockResolvedValue(undefined),
    queueTelegramDigestItems: jest.fn().mockResolvedValue(undefined),
  };

  const metricsService: {
    incrementAlertsSent: jest.Mock;
    incrementAlertDeliveryChannelFailure?: jest.Mock;
  } = { incrementAlertsSent: jest.fn() };

  if (!options.withoutChannelFailureMetric) {
    metricsService.incrementAlertDeliveryChannelFailure = jest.fn();
  }

  const emailRateLimitService = {
    reserve: jest.fn().mockResolvedValue(options.emailQuota ?? { allowed: true, limit: 100, used: 1, degraded: false }),
    release: jest.fn().mockResolvedValue(undefined),
  };

  const settingsRepository = {
    getByTenantId: jest.fn().mockResolvedValue(
      options.tenantSettings === null
        ? null
        : {
            webhookNotifierUrl: options.webhookNotifierUrl ?? null,
            recipientEmails: options.recipientEmails ?? [],
            telegramChatIds: options.telegramChatIds ?? [],
            telegramDeliveryMode: options.telegramDeliveryMode ?? 'instant',
          },
    ),
  };

  const telegramBotTokenResolverService = { resolveForTenant: jest.fn().mockReturnValue('bot-token') };
  const appConfigService = { webhookNotifierUrl: options.configuredWebhookNotifierUrl ?? null };

  const alertNotifier = {
    isEnabled: jest.fn().mockReturnValue(options.notifierEnabled ?? true),
    isEmailEnabled: jest.fn().mockReturnValue(options.emailEnabled ?? true),
    isTelegramEnabled: jest.fn().mockReturnValue(options.telegramEnabled ?? true),
    sendWebhook: options.sendWebhook ?? jest.fn().mockResolvedValue(undefined),
    sendEmail: options.sendEmail ?? jest.fn().mockResolvedValue(undefined),
    sendTelegram: options.sendTelegram ?? jest.fn().mockResolvedValue(undefined),
    sendTelegramDigest: jest.fn().mockResolvedValue(undefined),
  };

  const useCase = new ProcessAlertDeliveryUseCase(
    alertsRepository as never,
    metricsService as never,
    settingsRepository as never,
    telegramBotTokenResolverService as never,
    appConfigService as never,
    emailRateLimitService as never,
    alertNotifier,
  );

  return {
    useCase,
    alert,
    alertsRepository,
    metricsService,
    settingsRepository,
    telegramBotTokenResolverService,
    emailRateLimitService,
    alertNotifier,
  };
}

const FIRST_ATTEMPT = { alertId: 1, attemptNumber: 1, willRetry: false };

describe('ProcessAlertDeliveryUseCase', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects an alert that no longer exists', async () => {
    const { useCase, alertsRepository } = setup();
    alertsRepository.findByIdForWorker.mockResolvedValue(null);

    await expect(useCase.execute(FIRST_ATTEMPT)).rejects.toThrow('alert_not_found');
  });

  describe('channel selection', () => {
    it('never re-sends a channel already marked sent on a retry', async () => {
      const { useCase, alertNotifier, alertsRepository } = setup({
        webhookStatus: 'sent',
        webhookNotifierUrl: 'https://hooks.example.com/a',
        telegramChatIds: ['chat-1'],
      });

      await useCase.execute({ alertId: 1, attemptNumber: 2, willRetry: false });

      // Migration 0013 exists precisely so this does not happen.
      expect(alertNotifier.sendWebhook).not.toHaveBeenCalled();
      expect(alertNotifier.sendTelegram).toHaveBeenCalledTimes(1);
      expect(alertsRepository.markChannelDelivered).toHaveBeenCalledTimes(1);
      expect(alertsRepository.markChannelDelivered).toHaveBeenCalledWith(1, 'telegram');
    });

    it('re-attempts a channel whose previous attempt failed', async () => {
      const { useCase, alertNotifier } = setup({
        webhookStatus: 'failed',
        webhookNotifierUrl: 'https://hooks.example.com/a',
      });

      await useCase.execute({ alertId: 1, attemptNumber: 2, willRetry: false });

      expect(alertNotifier.sendWebhook).toHaveBeenCalledTimes(1);
    });

    it('falls back to the configured webhook URL when the tenant has none', async () => {
      const { useCase, alertNotifier } = setup({
        webhookNotifierUrl: null,
        configuredWebhookNotifierUrl: 'https://global.example.com/hook',
      });

      await useCase.execute(FIRST_ATTEMPT);

      expect(alertNotifier.sendWebhook).toHaveBeenCalledWith(
        expect.objectContaining({ id: '1' }),
        'https://global.example.com/hook',
      );
    });

    it('skips email when the notifier has no email transport configured', async () => {
      const { useCase, alertNotifier, alertsRepository } = setup({
        recipientEmails: ['a@example.com'],
        emailEnabled: false,
      });

      await useCase.execute(FIRST_ATTEMPT);

      expect(alertNotifier.sendEmail).not.toHaveBeenCalled();
      expect(alertsRepository.markDeliveryDisabled).toHaveBeenCalledWith(1);
    });

    it('marks delivery disabled and sends nothing when the notifier is globally disabled', async () => {
      const { useCase, alertNotifier, alertsRepository } = setup({
        notifierEnabled: false,
        webhookNotifierUrl: 'https://hooks.example.com/a',
        recipientEmails: ['a@example.com'],
        telegramChatIds: ['chat-1'],
      });

      await useCase.execute(FIRST_ATTEMPT);

      expect(alertsRepository.markDeliveryDisabled).toHaveBeenCalledWith(1);
      expect(alertNotifier.sendWebhook).not.toHaveBeenCalled();
      expect(alertNotifier.sendEmail).not.toHaveBeenCalled();
      expect(alertNotifier.sendTelegram).not.toHaveBeenCalled();
      expect(alertsRepository.markSent).not.toHaveBeenCalled();
    });

    it('marks delivery disabled when the tenant has configured no channel at all', async () => {
      const { useCase, alertsRepository } = setup({ tenantSettings: null });

      await useCase.execute(FIRST_ATTEMPT);

      expect(alertsRepository.markDeliveryDisabled).toHaveBeenCalledWith(1);
    });
  });

  describe('partial failures', () => {
    it('throws so the queue retries, without clearing the channel that did succeed', async () => {
      const sendWebhook = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
      const { useCase, alertsRepository, metricsService } = setup({
        webhookNotifierUrl: 'https://hooks.example.com/a',
        telegramChatIds: ['chat-1'],
        sendWebhook,
      });

      await expect(useCase.execute({ alertId: 1, attemptNumber: 1, willRetry: true })).rejects.toThrow(
        'notification_channels_failed:webhook:connect ECONNREFUSED',
      );

      // Telegram succeeded on this attempt and must stay recorded as sent, so
      // the retry only re-attempts the webhook.
      expect(alertsRepository.markChannelDelivered).toHaveBeenCalledTimes(1);
      expect(alertsRepository.markChannelDelivered).toHaveBeenCalledWith(1, 'telegram');
      expect(alertsRepository.markSent).not.toHaveBeenCalled();
      expect(metricsService.incrementAlertsSent).not.toHaveBeenCalled();
      expect(alertsRepository.markDeliveryFailure).toHaveBeenCalledWith(1, {
        attemptNumber: 1,
        error: 'notification_channels_failed:webhook:connect ECONNREFUSED',
        willRetry: true,
      });
    });

    it('collects every failing channel into a single error message', async () => {
      const { useCase } = setup({
        webhookNotifierUrl: 'https://hooks.example.com/a',
        recipientEmails: ['a@example.com'],
        sendWebhook: jest.fn().mockRejectedValue(new Error('webhook_down')),
        sendEmail: jest.fn().mockRejectedValue(new Error('email_down')),
      });

      await expect(useCase.execute(FIRST_ATTEMPT)).rejects.toThrow(
        'notification_channels_failed:webhook:webhook_down|email:email_down',
      );
    });

    it('does not check channel completion at all when a channel failed', async () => {
      const { useCase, alertsRepository } = setup({
        webhookNotifierUrl: 'https://hooks.example.com/a',
        sendWebhook: jest.fn().mockRejectedValue(new Error('webhook_down')),
      });

      await expect(useCase.execute(FIRST_ATTEMPT)).rejects.toThrow();
      expect(alertsRepository.checkAllChannelsDelivered).not.toHaveBeenCalled();
    });
  });

  describe('telegram instant delivery', () => {
    it('marks telegram delivered only when every chat id succeeded', async () => {
      const sendTelegram = jest.fn().mockResolvedValue(undefined);
      const { useCase, alertsRepository, alertNotifier } = setup({
        telegramChatIds: ['chat-1', 'chat-2'],
        sendTelegram,
      });

      await useCase.execute(FIRST_ATTEMPT);

      expect(alertNotifier.sendTelegram).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ id: '1' }),
        'chat-1',
        'bot-token',
      );
      expect(alertNotifier.sendTelegram).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ id: '1' }),
        'chat-2',
        'bot-token',
      );
      expect(alertsRepository.markChannelDelivered).toHaveBeenCalledWith(1, 'telegram');
    });

    it('leaves telegram pending when one chat id out of two failed', async () => {
      const sendTelegram = jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('chat not found'));
      const { useCase, alertsRepository } = setup({
        telegramChatIds: ['chat-1', 'chat-2'],
        sendTelegram,
      });

      await expect(useCase.execute(FIRST_ATTEMPT)).rejects.toThrow(
        'notification_channels_failed:telegram:chat-2:chat not found',
      );
      expect(alertsRepository.markChannelDelivered).not.toHaveBeenCalled();
    });

    it('does not stop at the first failing chat id', async () => {
      const sendTelegram = jest.fn().mockRejectedValue(new Error('chat not found'));
      const { useCase } = setup({ telegramChatIds: ['chat-1', 'chat-2'], sendTelegram });

      await expect(useCase.execute(FIRST_ATTEMPT)).rejects.toThrow(
        'notification_channels_failed:telegram:chat-1:chat not found|telegram:chat-2:chat not found',
      );
      expect(sendTelegram).toHaveBeenCalledTimes(2);
    });
  });

  describe('telegram digest mode', () => {
    it('queues digest items instead of sending instantly', async () => {
      const { useCase, alertNotifier, alertsRepository } = setup({
        telegramChatIds: ['chat-1', 'chat-2'],
        telegramDeliveryMode: 'digest_10m',
      });

      await useCase.execute(FIRST_ATTEMPT);

      expect(alertNotifier.sendTelegram).not.toHaveBeenCalled();
      expect(alertsRepository.queueTelegramDigestItems).toHaveBeenCalledWith({
        alertId: 1,
        tenantId: 'tenant-x',
        chatIds: ['chat-1', 'chat-2'],
      });
    });

    it('excludes telegram from the completion check so a queued digest does not block "sent"', async () => {
      const { useCase, alertsRepository } = setup({
        telegramChatIds: ['chat-1'],
        telegramDeliveryMode: 'digest_10m',
        webhookNotifierUrl: 'https://hooks.example.com/a',
      });

      await useCase.execute(FIRST_ATTEMPT);

      expect(alertsRepository.checkAllChannelsDelivered).toHaveBeenCalledWith(1, {
        hasWebhook: true,
        hasEmail: false,
        hasTelegram: false,
      });
    });

    it('does not queue a digest for a telegram channel already marked sent', async () => {
      const { useCase, alertsRepository } = setup({
        telegramChatIds: ['chat-1'],
        telegramDeliveryMode: 'digest_10m',
        telegramStatus: 'sent',
        webhookNotifierUrl: 'https://hooks.example.com/a',
      });

      await useCase.execute({ alertId: 1, attemptNumber: 2, willRetry: false });

      expect(alertsRepository.queueTelegramDigestItems).not.toHaveBeenCalled();
    });
  });

  describe('outbound email quota', () => {
    const QUOTA_EXHAUSTED = { allowed: false, limit: 100, used: 100, degraded: false };

    it('reserves a slot before handing the email to the transport', async () => {
      const { useCase, emailRateLimitService, alertNotifier } = setup({ recipientEmails: ['a@example.com'] });

      await useCase.execute(FIRST_ATTEMPT);

      expect(emailRateLimitService.reserve).toHaveBeenCalledWith('tenant-x');
      expect(alertNotifier.sendEmail).toHaveBeenCalledTimes(1);
    });

    it('does not send when the tenant exhausted its daily quota', async () => {
      const { useCase, alertNotifier } = setup({
        recipientEmails: ['a@example.com'],
        emailQuota: QUOTA_EXHAUSTED,
      });

      await useCase.execute(FIRST_ATTEMPT);

      expect(alertNotifier.sendEmail).not.toHaveBeenCalled();
    });

    it('records the email channel as failed with the quota reason instead of leaving it pending', async () => {
      // A silently dropped email that leaves the channel on `pending` is the
      // worst outcome: `checkAllChannelsDelivered` never converges and nobody
      // can tell from the API why the alert is stuck.
      const { useCase, alertsRepository } = setup({
        recipientEmails: ['a@example.com'],
        emailQuota: QUOTA_EXHAUSTED,
      });

      await useCase.execute(FIRST_ATTEMPT);

      expect(alertsRepository.markChannelFailed).toHaveBeenCalledWith(1, 'email');
      expect(alertsRepository.markDeliveryFailure).toHaveBeenCalledWith(1, {
        attemptNumber: 1,
        error: 'notification_channels_failed:email:quota_exceeded:daily_limit_100',
        willRetry: false,
      });
      expect(alertsRepository.markSent).not.toHaveBeenCalled();
    });

    it('does not throw on an exhausted quota, so the queue does not burn retries on it', async () => {
      // Retrying cannot conjure quota back before the UTC day rolls over, and a
      // thrown job would keep re-attempting the channels that already succeeded.
      const { useCase, alertsRepository } = setup({
        recipientEmails: ['a@example.com'],
        webhookNotifierUrl: 'https://hooks.example.com/a',
        emailQuota: QUOTA_EXHAUSTED,
      });

      await expect(useCase.execute({ alertId: 1, attemptNumber: 1, willRetry: true })).resolves.toBeUndefined();

      expect(alertsRepository.markChannelDelivered).toHaveBeenCalledWith(1, 'webhook');
      expect(alertsRepository.checkAllChannelsDelivered).not.toHaveBeenCalled();
      expect(alertsRepository.markDeliveryRetryPending).not.toHaveBeenCalled();
    });

    it('still throws when a retryable channel failed alongside the quota block', async () => {
      const { useCase } = setup({
        recipientEmails: ['a@example.com'],
        webhookNotifierUrl: 'https://hooks.example.com/a',
        emailQuota: QUOTA_EXHAUSTED,
        sendWebhook: jest.fn().mockRejectedValue(new Error('webhook_down')),
      });

      await expect(useCase.execute(FIRST_ATTEMPT)).rejects.toThrow(
        'notification_channels_failed:webhook:webhook_down|email:quota_exceeded:daily_limit_100',
      );
    });

    it('gives the reserved slot back when the transport itself fails', async () => {
      // The email never left; keeping the slot would spend the tenant's daily
      // allowance on a provider outage.
      const { useCase, emailRateLimitService } = setup({
        recipientEmails: ['a@example.com'],
        sendEmail: jest.fn().mockRejectedValue(new Error('email_down')),
      });

      await expect(useCase.execute(FIRST_ATTEMPT)).rejects.toThrow('notification_channels_failed:email:email_down');
      expect(emailRateLimitService.release).toHaveBeenCalledWith('tenant-x');
    });

    it('keeps the slot when the email was delivered', async () => {
      const { useCase, emailRateLimitService } = setup({ recipientEmails: ['a@example.com'] });

      await useCase.execute(FIRST_ATTEMPT);

      expect(emailRateLimitService.release).not.toHaveBeenCalled();
    });

    it('does not consult the quota for a channel it is not going to attempt', async () => {
      const { useCase, emailRateLimitService } = setup({
        recipientEmails: ['a@example.com'],
        emailStatus: 'sent',
        webhookNotifierUrl: 'https://hooks.example.com/a',
      });

      await useCase.execute({ alertId: 1, attemptNumber: 2, willRetry: false });

      expect(emailRateLimitService.reserve).not.toHaveBeenCalled();
    });
  });

  describe('channel failure metrics', () => {
    it('counts every failing channel, not just the joined error string', async () => {
      const { useCase, metricsService } = setup({
        webhookNotifierUrl: 'https://hooks.example.com/a',
        telegramChatIds: ['chat-1'],
        sendWebhook: jest.fn().mockRejectedValue(new Error('webhook_down')),
        sendTelegram: jest.fn().mockRejectedValue(new Error('chat_not_found')),
      });

      await expect(useCase.execute(FIRST_ATTEMPT)).rejects.toThrow();

      expect(metricsService.incrementAlertDeliveryChannelFailure).toHaveBeenCalledWith('webhook');
      expect(metricsService.incrementAlertDeliveryChannelFailure).toHaveBeenCalledWith('telegram');
    });

    it('counts a quota-blocked email as a channel failure', async () => {
      const { useCase, metricsService } = setup({
        recipientEmails: ['a@example.com'],
        emailQuota: { allowed: false, limit: 100, used: 100, degraded: false },
      });

      await useCase.execute(FIRST_ATTEMPT);

      expect(metricsService.incrementAlertDeliveryChannelFailure).toHaveBeenCalledWith('email');
    });

    it('delivers normally against a MetricsService that does not expose the counter yet', async () => {
      // The counter is added to MetricsService by the observability pass; this
      // use case must not depend on the order those two land in.
      const { useCase, alertsRepository } = setup({
        webhookNotifierUrl: 'https://hooks.example.com/a',
        sendWebhook: jest.fn().mockRejectedValue(new Error('webhook_down')),
        withoutChannelFailureMetric: true,
      });

      await expect(useCase.execute(FIRST_ATTEMPT)).rejects.toThrow('notification_channels_failed:webhook:webhook_down');
      expect(alertsRepository.markDeliveryFailure).toHaveBeenCalled();
    });
  });

  describe('completion', () => {
    it('marks the alert sent and counts it exactly once when every channel is delivered', async () => {
      const { useCase, alertsRepository, metricsService } = setup({
        webhookNotifierUrl: 'https://hooks.example.com/a',
        recipientEmails: ['a@example.com'],
        telegramChatIds: ['chat-1'],
        allDelivered: true,
      });

      await useCase.execute({ alertId: 1, attemptNumber: 3, willRetry: false });

      expect(alertsRepository.checkAllChannelsDelivered).toHaveBeenCalledWith(1, {
        hasWebhook: true,
        hasEmail: true,
        hasTelegram: true,
      });
      expect(alertsRepository.markSent).toHaveBeenCalledWith(1, 3);
      expect(metricsService.incrementAlertsSent).toHaveBeenCalledTimes(1);
      expect(metricsService.incrementAlertsSent).toHaveBeenCalledWith(1);
    });

    it('does not double count when markSent reports the alert was already sent', async () => {
      const { useCase, metricsService } = setup({
        webhookNotifierUrl: 'https://hooks.example.com/a',
        allDelivered: true,
        markSentReturns: false,
      });

      await useCase.execute(FIRST_ATTEMPT);

      expect(metricsService.incrementAlertsSent).not.toHaveBeenCalled();
    });

    it('routes a pending channel to markDeliveryRetryPending when the job will retry', async () => {
      const { useCase, alertsRepository } = setup({
        webhookNotifierUrl: 'https://hooks.example.com/a',
        allDelivered: false,
      });

      await useCase.execute({ alertId: 1, attemptNumber: 2, willRetry: true });

      expect(alertsRepository.markDeliveryRetryPending).toHaveBeenCalledWith(1, 2);
      // Nothing threw, so this is not a failure: the alert is still in flight.
      expect(alertsRepository.markDeliveryFailure).not.toHaveBeenCalled();
      expect(alertsRepository.markSent).not.toHaveBeenCalled();
    });

    it('leaves the delivery status untouched when channels are pending and no retry follows', async () => {
      const { useCase, alertsRepository } = setup({
        webhookNotifierUrl: 'https://hooks.example.com/a',
        allDelivered: false,
      });

      await useCase.execute({ alertId: 1, attemptNumber: 5, willRetry: false });

      expect(alertsRepository.markDeliveryRetryPending).not.toHaveBeenCalled();
      expect(alertsRepository.markSent).not.toHaveBeenCalled();
      expect(alertsRepository.markDeliveryFailure).not.toHaveBeenCalled();
    });
  });
});
