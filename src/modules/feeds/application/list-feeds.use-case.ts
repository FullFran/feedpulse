import { Injectable } from '@nestjs/common';

import { FeedsRepository } from '../feeds.repository';

@Injectable()
export class ListFeedsUseCase {
  constructor(private readonly feedsRepository: FeedsRepository) {}

  execute(input: { status?: string; query?: string; page: number; pageSize: number }) {
    return this.feedsRepository.list(input);
  }
}
