import { Injectable } from '@nestjs/common';

import { OpmlImportsRepository } from '../opml-imports.repository';

@Injectable()
export class GetOpmlPreviewUseCase {
  constructor(private readonly opmlImportsRepository: OpmlImportsRepository) {}

  async execute(input: { tenantId?: string; importId: number; page: number; pageSize: number }) {
    const summary = await this.opmlImportsRepository.getImportOrThrow(input.importId, input.tenantId ?? 'legacy');
    const preview = await this.opmlImportsRepository.listPreviewItems(input.importId, input.page, input.pageSize);

    return {
      import: summary,
      items: preview.items,
      total: preview.total,
    };
  }
}
