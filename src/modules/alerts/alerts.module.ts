import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module';
import { ObservabilityModule } from '../observability/observability.module';
import { SettingsModule } from '../settings/settings.module';

import { AlertsRepository } from './alerts.repository';
import { DeliverAlertUseCase } from './application/deliver-alert.use-case';
import { GetAlertUseCase } from './application/get-alert.use-case';
import { ListAlertsUseCase } from './application/list-alerts.use-case';
import { ProcessAlertDeliveryUseCase } from './application/process-alert-delivery.use-case';
import { AlertsController } from './http/alerts.controller';

@Module({
  imports: [NotificationsModule, ObservabilityModule, SettingsModule],
  controllers: [AlertsController],
  providers: [AlertsRepository, ListAlertsUseCase, GetAlertUseCase, DeliverAlertUseCase, ProcessAlertDeliveryUseCase],
  exports: [AlertsRepository, GetAlertUseCase, DeliverAlertUseCase, ProcessAlertDeliveryUseCase],
})
export class AlertsModule {}
