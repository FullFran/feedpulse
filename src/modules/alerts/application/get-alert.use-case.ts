import { Injectable, NotFoundException } from '@nestjs/common';

import { AlertsRepository } from '../alerts.repository';

@Injectable()
export class GetAlertUseCase {
  constructor(private readonly alertsRepository: AlertsRepository) {}

  async execute(id: number) {
    const alert = await this.alertsRepository.findById(id);

    if (!alert) {
      throw new NotFoundException('alert_not_found');
    }

    return alert;
  }
}
