import { Injectable } from '@nestjs/common';

import { RulesRepository } from '../rules.repository';

@Injectable()
export class ListRulesUseCase {
  constructor(private readonly rulesRepository: RulesRepository) {}

  execute(input: { tenantId: string; page: number; pageSize: number; isActive?: boolean; query?: string }) {
    return this.rulesRepository.list(input);
  }
}
