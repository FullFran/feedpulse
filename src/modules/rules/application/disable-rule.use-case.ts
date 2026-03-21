import { Injectable, NotFoundException } from '@nestjs/common';

import { RulesRepository } from '../rules.repository';

@Injectable()
export class DisableRuleUseCase {
  constructor(private readonly rulesRepository: RulesRepository) {}

  async execute(id: number): Promise<void> {
    const disabled = await this.rulesRepository.disable(id);

    if (!disabled) {
      throw new NotFoundException('rule_not_found');
    }
  }
}
