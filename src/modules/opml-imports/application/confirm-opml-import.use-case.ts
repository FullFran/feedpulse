import { ConflictException, Inject, Injectable } from '@nestjs/common';

import {
  OPML_APPLY_IMPORT_QUEUE_TOKEN,
  OpmlApplyImportQueuePort,
} from '../../../infrastructure/queue/queue.constants';

import { OpmlImportsRepository } from '../opml-imports.repository';

@Injectable()
export class ConfirmOpmlImportUseCase {
  constructor(
    private readonly opmlImportsRepository: OpmlImportsRepository,
    @Inject(OPML_APPLY_IMPORT_QUEUE_TOKEN) private readonly opmlApplyImportQueue: OpmlApplyImportQueuePort,
  ) {}

  async execute(importId: number): Promise<{ id: string; status: 'queued' | 'already_confirmed' }> {
    const current = await this.opmlImportsRepository.getImportOrThrow(importId);

    if (current.status === 'importing' || current.status === 'completed') {
      return { id: current.id, status: 'already_confirmed' };
    }

    if (current.status !== 'preview_ready') {
      throw new ConflictException('opml_import_not_ready_for_confirm');
    }

    const updated = await this.opmlImportsRepository.markImportStatus(importId, {
      status: 'importing',
      confirmed: true,
    });

    await this.opmlApplyImportQueue.enqueue({
      importId,
      requestedAt: new Date().toISOString(),
    });

    return { id: updated.id, status: 'queued' };
  }
}
