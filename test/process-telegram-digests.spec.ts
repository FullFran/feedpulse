import { Logger } from '@nestjs/common';
import type { TelegramDigestGroup } from '../src/modules/alerts/alerts.repository';
import { ProcessTelegramDigestsUseCase } from '../src/modules/alerts/application/process-telegram-digests.use-case';
import { expectDefined } from './support/expect-defined';

/**
 * Digest flushing for Telegram.
 *
 * The load-bearing invariant is that `markTelegramDigestGroupSent` runs ONLY
 * after `sendTelegramDigest` resolved. Marking first would mean a transient
 * Telegram outage permanently discards those alerts: nothing else ever picks
 * them up again. The second invariant is isolation — one broken chat must not
 * stop the remaining groups from being flushed.
 *
 * The third, added later: flushing a digest must also converge the alert's
 * `telegram_delivery_status`. It never did, so every `digest_10m` tenant had
 * alerts that were delivered but reported as pending by the API, the dashboard
 * and the partial pending index — forever.
 */

function buildGroup(overrides: Partial<TelegramDigestGroup> = {}): TelegramDigestGroup {
  return {
    tenantId: 'tenant-x',
    chatId: 'chat-1',
    scheduledFor: '2026-03-20T09:10:00.000Z',
    items: [
      {
        digestItemId: 1,
        alertId: '11',
        createdAt: '2026-03-20T09:00:00.000Z',
        title: 'First',
        link: 'https://example.com/1',
        snippet: 'a',
      },
      {
        digestItemId: 2,
        alertId: '12',
        createdAt: '2026-03-20T09:05:00.000Z',
        title: 'Second',
        link: 'https://example.com/2',
        snippet: 'b',
      },
    ],
    ...overrides,
  };
}

interface SetupOptions {
  groups?: TelegramDigestGroup[];
  notifierEnabled?: boolean;
  telegramEnabledFor?: (token: string | undefined) => boolean;
  resolveForTenant?: (input: { tenantId: string }) => string | undefined;
  sendTelegramDigest?: jest.Mock;
  /** Alert ids the repository reports as converged by each group flush. */
  alertIdsDelivered?: string[];
  /** Alert ids the reconciliation pass repairs before the sweep starts. */
  reconciledAlertIds?: string[];
  reconcileRejects?: Error;
}

function setup(options: SetupOptions = {}) {
  const reconcileTelegramDigestDeliveryStatus = options.reconcileRejects
    ? jest.fn().mockRejectedValue(options.reconcileRejects)
    : jest.fn().mockResolvedValue({ alertIdsDelivered: options.reconciledAlertIds ?? [] });

  const alertsRepository = {
    listDueTelegramDigestGroups: jest.fn().mockResolvedValue(options.groups ?? []),
    markTelegramDigestGroupSent: jest.fn().mockResolvedValue({ alertIdsDelivered: options.alertIdsDelivered ?? [] }),
    reconcileTelegramDigestDeliveryStatus,
  };

  const settingsRepository = {
    getByTenantId: jest.fn().mockImplementation(async (tenantId: string) => ({ tenantId })),
  };

  const telegramBotTokenResolverService = {
    resolveForTenant: jest
      .fn()
      .mockImplementation((input: { tenantId: string }) =>
        options.resolveForTenant ? options.resolveForTenant(input) : `token-${input.tenantId}`,
      ),
  };

  const alertNotifier = {
    isEnabled: jest.fn().mockReturnValue(options.notifierEnabled ?? true),
    isEmailEnabled: jest.fn().mockReturnValue(false),
    isTelegramEnabled: jest
      .fn()
      .mockImplementation((token?: string) =>
        options.telegramEnabledFor ? options.telegramEnabledFor(token) : Boolean(token),
      ),
    sendWebhook: jest.fn(),
    sendEmail: jest.fn(),
    sendTelegram: jest.fn(),
    sendTelegramDigest: options.sendTelegramDigest ?? jest.fn().mockResolvedValue(undefined),
  };

  const useCase = new ProcessTelegramDigestsUseCase(
    alertsRepository as never,
    settingsRepository as never,
    telegramBotTokenResolverService as never,
    alertNotifier,
  );

  return { useCase, alertsRepository, settingsRepository, telegramBotTokenResolverService, alertNotifier };
}

describe('ProcessTelegramDigestsUseCase', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns early without touching the database when the notifier is disabled', async () => {
    const { useCase, alertsRepository } = setup({ notifierEnabled: false, groups: [buildGroup()] });

    await expect(useCase.execute()).resolves.toEqual({ processedGroups: 0, sentItems: 0, alertsMarkedDelivered: 0 });
    expect(alertsRepository.listDueTelegramDigestGroups).not.toHaveBeenCalled();
  });

  it('queries due groups with the supplied instant and group cap', async () => {
    const { useCase, alertsRepository } = setup();

    await useCase.execute({ now: new Date('2026-03-20T09:10:00.000Z'), maxGroups: 5 });

    expect(alertsRepository.listDueTelegramDigestGroups).toHaveBeenCalledWith({
      nowIso: '2026-03-20T09:10:00.000Z',
      maxGroups: 5,
    });
  });

  it('defaults the group cap to 30', async () => {
    const { useCase, alertsRepository } = setup();

    await useCase.execute();

    expect(alertsRepository.listDueTelegramDigestGroups).toHaveBeenCalledWith(
      expect.objectContaining({ maxGroups: 30 }),
    );
  });

  it('sends a group and only then marks its items as sent', async () => {
    const order: string[] = [];
    const sendTelegramDigest = jest.fn().mockImplementation(async () => {
      order.push('send');
    });
    const { useCase, alertsRepository } = setup({ groups: [buildGroup()], sendTelegramDigest });
    alertsRepository.markTelegramDigestGroupSent.mockImplementation(async () => {
      order.push('mark');
      return { alertIdsDelivered: [] };
    });

    const result = await useCase.execute();

    expect(order).toEqual(['send', 'mark']);
    expect(alertsRepository.markTelegramDigestGroupSent).toHaveBeenCalledWith([
      { digestItemId: 1, alertId: '11' },
      { digestItemId: 2, alertId: '12' },
    ]);
    expect(result).toEqual({ processedGroups: 1, sentItems: 2, alertsMarkedDelivered: 0 });
  });

  it('forwards the tenant bot token and the item payload to the notifier', async () => {
    const { useCase, alertNotifier } = setup({ groups: [buildGroup()] });

    await useCase.execute();

    expect(alertNotifier.sendTelegramDigest).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-x',
        chatId: 'chat-1',
        telegramBotToken: 'token-tenant-x',
        items: [
          { title: 'First', snippet: 'a', link: 'https://example.com/1' },
          { title: 'Second', snippet: 'b', link: 'https://example.com/2' },
        ],
      }),
    );
  });

  it('builds a window label around the scheduled instant without depending on the host ICU build', async () => {
    const { useCase, alertNotifier } = setup({ groups: [buildGroup({ scheduledFor: '2026-03-20T09:10:00.000Z' })] });

    await useCase.execute();

    const payload = alertNotifier.sendTelegramDigest.mock.calls[0][0] as { windowLabel: string };
    // The label is produced with toLocaleString('es-ES'), whose exact output
    // (separators, 12h/24h, narrow no-break spaces) varies between Node ICU
    // builds. Only the stable envelope is asserted.
    expect(payload.windowLabel.startsWith('Ventana hasta ')).toBe(true);
    expect(payload.windowLabel.endsWith(' UTC')).toBe(true);
    expect(payload.windowLabel).toContain('2026');
  });

  it('does not mark items as sent when Telegram is down, so the digest survives the outage', async () => {
    const sendTelegramDigest = jest.fn().mockRejectedValue(new Error('telegram_unavailable'));
    const { useCase, alertsRepository } = setup({ groups: [buildGroup()], sendTelegramDigest });

    const result = await useCase.execute();

    expect(alertsRepository.markTelegramDigestGroupSent).not.toHaveBeenCalled();
    expect(result).toEqual({ processedGroups: 0, sentItems: 0, alertsMarkedDelivered: 0 });
  });

  it('keeps flushing the remaining groups after one chat fails', async () => {
    const sendTelegramDigest = jest
      .fn()
      .mockRejectedValueOnce(new Error('chat_not_found'))
      .mockResolvedValueOnce(undefined);
    const { useCase, alertsRepository } = setup({
      groups: [
        buildGroup({ chatId: 'broken-chat' }),
        buildGroup({
          chatId: 'healthy-chat',
          items: [
            {
              digestItemId: 3,
              alertId: '13',
              createdAt: '2026-03-20T09:06:00.000Z',
              title: 'Third',
              link: 'https://example.com/3',
              snippet: 'c',
            },
          ],
        }),
      ],
      sendTelegramDigest,
    });

    const result = await useCase.execute();

    expect(sendTelegramDigest).toHaveBeenCalledTimes(2);
    expect(alertsRepository.markTelegramDigestGroupSent).toHaveBeenCalledTimes(1);
    expect(alertsRepository.markTelegramDigestGroupSent).toHaveBeenCalledWith([{ digestItemId: 3, alertId: '13' }]);
    // The failed group is excluded from both counters.
    expect(result).toEqual({ processedGroups: 1, sentItems: 1, alertsMarkedDelivered: 0 });
  });

  it('skips a group whose tenant has no resolvable bot token', async () => {
    const { useCase, alertsRepository, alertNotifier } = setup({
      groups: [buildGroup({ tenantId: 'tenant-without-token' }), buildGroup({ tenantId: 'tenant-x' })],
      resolveForTenant: ({ tenantId }) => (tenantId === 'tenant-without-token' ? undefined : `token-${tenantId}`),
    });

    const result = await useCase.execute();

    expect(alertNotifier.sendTelegramDigest).toHaveBeenCalledTimes(1);
    expect(alertNotifier.sendTelegramDigest).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-x' }));
    expect(alertsRepository.markTelegramDigestGroupSent).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ processedGroups: 1, sentItems: 2, alertsMarkedDelivered: 0 });
  });

  it('skips an empty group without calling the notifier', async () => {
    const { useCase, alertNotifier, settingsRepository } = setup({ groups: [buildGroup({ items: [] })] });

    const result = await useCase.execute();

    expect(alertNotifier.sendTelegramDigest).not.toHaveBeenCalled();
    expect(settingsRepository.getByTenantId).not.toHaveBeenCalled();
    expect(result).toEqual({ processedGroups: 0, sentItems: 0, alertsMarkedDelivered: 0 });
  });

  it('resolves the bot token per tenant rather than once for the batch', async () => {
    const { useCase, telegramBotTokenResolverService } = setup({
      groups: [buildGroup({ tenantId: 'tenant-a' }), buildGroup({ tenantId: 'tenant-b' })],
    });

    await useCase.execute();

    expect(telegramBotTokenResolverService.resolveForTenant).toHaveBeenCalledTimes(2);
    expect(telegramBotTokenResolverService.resolveForTenant).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ tenantId: 'tenant-a' }),
    );
    expect(telegramBotTokenResolverService.resolveForTenant).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ tenantId: 'tenant-b' }),
    );
  });

  describe('per-channel convergence', () => {
    it('hands the repository the alert id of every flushed item, not just the item ids', async () => {
      // Without the alert ids the channel could never be marked, which is the
      // whole bug: `telegram_delivery_status` stayed 'pending' for every
      // digest-mode tenant while the digests were being delivered normally.
      const { useCase, alertsRepository } = setup({ groups: [buildGroup()] });

      await useCase.execute();

      expect(alertsRepository.markTelegramDigestGroupSent).toHaveBeenCalledWith([
        { digestItemId: 1, alertId: '11' },
        { digestItemId: 2, alertId: '12' },
      ]);
    });

    it('reports the alerts whose telegram channel converged to sent', async () => {
      const { useCase } = setup({ groups: [buildGroup()], alertIdsDelivered: ['11', '12'] });

      await expect(useCase.execute()).resolves.toEqual({
        processedGroups: 1,
        sentItems: 2,
        alertsMarkedDelivered: 2,
      });
    });

    it('does not count an alert whose other chat ids are still unflushed', async () => {
      // The repository refuses to converge an alert that still has unsent digest
      // items; the use case must not invent a number it was not given.
      const { useCase } = setup({
        groups: [buildGroup({ items: [{ ...expectDefined(buildGroup().items[0]) }] })],
        alertIdsDelivered: [],
      });

      const result = await useCase.execute();

      expect(result.sentItems).toBe(1);
      expect(result.alertsMarkedDelivered).toBe(0);
    });

    it('reconciles alerts left pending by an earlier sweep before flushing new ones', async () => {
      const calls: string[] = [];
      const { useCase, alertsRepository } = setup({
        groups: [buildGroup()],
        reconciledAlertIds: ['7', '8'],
      });
      alertsRepository.reconcileTelegramDigestDeliveryStatus.mockImplementation(async () => {
        calls.push('reconcile');
        return { alertIdsDelivered: ['7', '8'] };
      });
      alertsRepository.listDueTelegramDigestGroups.mockImplementation(async () => {
        calls.push('list');
        return [buildGroup()];
      });

      const result = await useCase.execute();

      // Repair first: a crash between "items sent" and "channel marked" in a
      // previous tick must heal before more work is piled on top.
      expect(calls).toEqual(['reconcile', 'list']);
      expect(result.alertsMarkedDelivered).toBe(2);
    });

    it('still flushes the due groups when the reconciliation pass fails', async () => {
      const { useCase, alertNotifier } = setup({
        groups: [buildGroup()],
        reconcileRejects: new Error('deadlock detected'),
      });

      const result = await useCase.execute();

      expect(alertNotifier.sendTelegramDigest).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ processedGroups: 1, sentItems: 2, alertsMarkedDelivered: 0 });
    });

    it('does not reconcile at all when the notifier is disabled', async () => {
      const { useCase, alertsRepository } = setup({ notifierEnabled: false, groups: [buildGroup()] });

      await useCase.execute();

      expect(alertsRepository.reconcileTelegramDigestDeliveryStatus).not.toHaveBeenCalled();
    });
  });
});
