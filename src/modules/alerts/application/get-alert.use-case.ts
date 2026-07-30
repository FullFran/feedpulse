import { Injectable, NotFoundException } from '@nestjs/common';
import { AlertsRepository } from '../alerts.repository';

@Injectable()
export class GetAlertUseCase {
  constructor(private readonly alertsRepository: AlertsRepository) {}

  // `tenantId` is required: this use case only ever serves an authenticated HTTP
  // request, and an omitted tenant would silently widen the read to every tenant.
  async execute(id: number, tenantId: string) {
    const alert = await this.alertsRepository.findByIdForTenant(id, tenantId);

    if (!alert) {
      throw new NotFoundException('alert_not_found');
    }

    return alert;
  }
}
