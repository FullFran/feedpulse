import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { MetricsService } from '../../observability/metrics.service';
import { ALERT_NOTIFIER, AlertNotifierPort } from '../../notifications/domain/alert-notifier.port';

import { AlertsRepository } from '../alerts.repository';

@Injectable()
export class ProcessAlertDeliveryUseCase {
  private readonly logger = new Logger(ProcessAlertDeliveryUseCase.name);

  constructor(
    private readonly alertsRepository: AlertsRepository,
    private readonly metricsService: MetricsService,
    @Inject(ALERT_NOTIFIER) private readonly alertNotifier: AlertNotifierPort,
  ) {}

  async execute(input: { alertId: number; attemptNumber: number; willRetry: boolean }): Promise<void> {
    const alert = await this.alertsRepository.findById(input.alertId);

    if (!alert) {
      throw new NotFoundException('alert_not_found');
    }

    if (alert.sent) {
      return;
    }

    if (!this.alertNotifier.isEnabled()) {
      await this.alertsRepository.markDeliveryDisabled(input.alertId);
      return;
    }

    try {
      await this.alertNotifier.send(alert);
      const firstSuccessfulDelivery = await this.alertsRepository.markSent(input.alertId, input.attemptNumber);

      if (firstSuccessfulDelivery) {
        this.metricsService.incrementAlertsSent(1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_delivery_failure';
      await this.alertsRepository.markDeliveryFailure(input.alertId, {
        attemptNumber: input.attemptNumber,
        error: message,
        willRetry: input.willRetry,
      });
      this.logger.warn(`Alert ${input.alertId} delivery attempt ${input.attemptNumber} failed: ${message}`);
      throw error;
    }
  }
}
