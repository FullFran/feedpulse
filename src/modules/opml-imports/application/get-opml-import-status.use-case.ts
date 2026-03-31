import { Injectable } from '@nestjs/common';

import { OpmlImportsRepository } from '../opml-imports.repository';

@Injectable()
export class GetOpmlImportStatusUseCase {
  constructor(private readonly opmlImportsRepository: OpmlImportsRepository) {}

  async execute(importId: number) {
    const summary = await this.opmlImportsRepository.getImportOrThrow(importId);
    const grouped = await this.opmlImportsRepository.countItemsByStatus(importId);

    return {
      ...summary,
      progressPercent: this.calculateProgress(summary.status),
      failedItems: grouped.failed ?? 0,
    };
  }

  private calculateProgress(status: string): number {
    switch (status) {
      case 'uploaded':
        return 10;
      case 'parsing':
        return 30;
      case 'preview_ready':
        return 60;
      case 'importing':
        return 80;
      case 'completed':
        return 100;
      case 'failed_validation':
      case 'failed':
        return 100;
      default:
        return 0;
    }
  }
}
