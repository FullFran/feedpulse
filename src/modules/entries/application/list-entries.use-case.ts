import { Injectable } from '@nestjs/common';

import { EntriesRepository } from '../entries.repository';

@Injectable()
export class ListEntriesUseCase {
  constructor(private readonly entriesRepository: EntriesRepository) {}

  execute(input: { tenantId: string; page: number; pageSize: number; feedId?: number; search?: string; from?: string; to?: string }) {
    return this.entriesRepository.list(input);
  }
}
