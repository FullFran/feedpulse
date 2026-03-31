import { Injectable } from '@nestjs/common';

import { AlertsRepository } from '../alerts.repository';

@Injectable()
export class ListAlertsUseCase {
  constructor(private readonly alertsRepository: AlertsRepository) {}

  execute(input: { tenantId: string; page: number; pageSize: number; sent?: boolean }) {
    return this.alertsRepository.list(input);
  }
}
