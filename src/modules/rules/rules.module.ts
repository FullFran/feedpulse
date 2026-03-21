import { Module } from '@nestjs/common';

import { CreateRuleUseCase } from './application/create-rule.use-case';
import { DisableRuleUseCase } from './application/disable-rule.use-case';
import { GetRuleUseCase } from './application/get-rule.use-case';
import { ListRulesUseCase } from './application/list-rules.use-case';
import { UpdateRuleUseCase } from './application/update-rule.use-case';
import { RulesController } from './http/rules.controller';
import { RulesRepository } from './rules.repository';

@Module({
  controllers: [RulesController],
  providers: [RulesRepository, CreateRuleUseCase, ListRulesUseCase, GetRuleUseCase, UpdateRuleUseCase, DisableRuleUseCase],
  exports: [RulesRepository],
})
export class RulesModule {}
