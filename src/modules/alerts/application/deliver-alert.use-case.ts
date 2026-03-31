import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { ALERT_DELIVERY_QUEUE_TOKEN, AlertDeliveryQueuePort } from '../../../infrastructure/queue/queue.constants';
import { ALERT_NOTIFIER, AlertNotifierPort } from '../../notifications/domain/alert-notifier.port';

import { AlertsRepository } from '../alerts.repository';

@Injectable()
export class DeliverAlertUseCase {
  constructor(
    private readonly alertsRepository: AlertsRepository,
    @Inject(ALERT_DELIVERY_QUEUE_TOKEN) private readonly alertDeliveryQueue: AlertDeliveryQueuePort,
    @Inject(ALERT_NOTIFIER) private readonly alertNotifier: AlertNotifierPort,
  ) {}

  async execute(
    alertId: number,
    source: 'ingestion' | 'manual' = 'manual',
    tenantId?: string,
  ): Promise<{ id: string; status: 'queued' | 'already_sent' | 'disabled' }> {
    const alert = await this.alertsRepository.findById(alertId, source === 'manual' ? tenantId : undefined);

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
