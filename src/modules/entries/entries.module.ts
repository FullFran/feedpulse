import { Module } from '@nestjs/common';

import { ListEntriesUseCase } from './application/list-entries.use-case';
import { EntriesRepository } from './entries.repository';
import { EntriesController } from './http/entries.controller';

@Module({
  controllers: [EntriesController],
  providers: [EntriesRepository, ListEntriesUseCase],
  exports: [EntriesRepository],
})
export class EntriesModule {}
