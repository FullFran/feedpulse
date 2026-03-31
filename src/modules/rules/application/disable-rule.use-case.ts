import { Injectable, NotFoundException } from '@nestjs/common';

import { RulesRepository } from '../rules.repository';

@Injectable()
export class DisableRuleUseCase {
  constructor(private readonly rulesRepository: RulesRepository) {}

  async execute(id: number, tenantId: string): Promise<void> {
    const disabled = await this.rulesRepository.disable(id, tenantId);

    if (!disabled) {
      throw new NotFoundException('rule_not_found');
    }
  }
}
