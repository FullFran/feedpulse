import { Injectable, NotFoundException } from '@nestjs/common';

import { RulesRepository } from '../rules.repository';

@Injectable()
export class GetRuleUseCase {
  constructor(private readonly rulesRepository: RulesRepository) {}

  async execute(id: number) {
    const rule = await this.rulesRepository.findById(id);

    if (!rule) {
      throw new NotFoundException('rule_not_found');
    }

    return rule;
  }
}
