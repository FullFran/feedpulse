import { Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ALERT_DELIVERY_QUEUE_TOKEN, AlertDeliveryQueuePort } from '../../../infrastructure/queue/queue.constants';
import { ALERT_NOTIFIER, AlertNotifierPort } from '../../notifications/domain/alert-notifier.port';
import { AlertNotificationRecord, AlertsRepository } from '../alerts.repository';

@Injectable()
export class DeliverAlertUseCase {
  constructor(
    private readonly alertsRepository: AlertsRepository,
    @Inject(ALERT_DELIVERY_QUEUE_TOKEN) private readonly alertDeliveryQueue: AlertDeliveryQueuePort,
    @Inject(ALERT_NOTIFIER) private readonly alertNotifier: AlertNotifierPort,
  ) {}

  /**
   * `source` decides which lookup is used, and the two are deliberately different:
   *
   * - `manual` is an authenticated HTTP request. It MUST carry a tenant id, and the alert is
   *   read through the tenant-scoped lookup. Previously a manual call with no tenant id fell
   *   through to an unscoped read, so any authenticated caller could queue delivery of any
   *   other tenant's alert just by guessing its (sequential) id. That now fails closed.
   * - `ingestion` is the in-process worker path. It has an alert id produced moments earlier
   *   by the same transaction and no request context, so it reads cross-tenant on purpose
   *   through the explicitly named `findByIdForWorker`.
   */
  async execute(
    alertId: number,
    source: 'ingestion' | 'manual' = 'manual',
    tenantId?: string,
  ): Promise<{ id: string; status: 'queued' | 'already_sent' | 'disabled' }> {
    let alert: AlertNotificationRecord | null;

    if (source === 'manual') {
      if (!tenantId) {
        throw new UnauthorizedException('missing_tenant_context');
      }

      alert = await this.alertsRepository.findByIdForTenant(alertId, tenantId);
    } else {
      alert = await this.alertsRepository.findByIdForWorker(alertId);
    }

    if (!alert) {
      throw new NotFoundException('alert_not_found');
    }

    if (alert.sent) {
      return { id: alert.id, status: 'already_sent' };
    }

    if (!this.alertNotifier.isEnabled()) {
      await this.alertsRepository.markDeliveryDisabled(alertId);
      return { id: alert.id, status: 'disabled' };
    }

    await this.alertsRepository.markDeliveryQueued(alertId);
    await this.alertDeliveryQueue.enqueue({
      alertId,
      queuedAt: new Date().toISOString(),
      source,
    });

    return { id: alert.id, status: 'queued' };
  }
}
