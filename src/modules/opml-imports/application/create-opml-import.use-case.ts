import { createHash } from 'node:crypto';

import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import {
  OPML_PARSE_PREVIEW_QUEUE_TOKEN,
  OpmlParsePreviewQueuePort,
} from '../../../infrastructure/queue/queue.constants';
import { AppConfigService } from '../../../shared/config/app-config.service';

import { OpmlImportsRepository } from '../opml-imports.repository';

@Injectable()
export class CreateOpmlImportUseCase {
  private static readonly ALLOWED_MIME_TYPES = new Set([
    'text/xml',
    'application/xml',
    'text/x-opml',
    'application/octet-stream',
  ]);

  constructor(
    private readonly opmlImportsRepository: OpmlImportsRepository,
    @Inject(OPML_PARSE_PREVIEW_QUEUE_TOKEN) private readonly opmlParsePreviewQueue: OpmlParsePreviewQueuePort,
    @Inject(AppConfigService) private readonly appConfigService: AppConfigService,
  ) {}

  async execute(input: { fileName: string; mimeType: string; content: Buffer }): Promise<{ id: string; status: string; parseQueued: boolean }> {
    this.validateUpload(input);

    const sourceChecksum = createHash('sha256').update(input.content).digest('hex');
    const created = await this.opmlImportsRepository.createImport({
      fileName: input.fileName,
      fileSizeBytes: input.content.length,
      sourceChecksum,
    });

    await this.opmlParsePreviewQueue.enqueue({
      importId: Number(created.id),
      opmlXml: input.content.toString('utf8'),
    });

    return {
      id: created.id,
      status: created.status,
      parseQueued: true,
    };
  }

  private validateUpload(input: { fileName: string; mimeType: string; content: Buffer }): void {
    if (!input.content || input.content.length === 0) {
      throw new BadRequestException('opml_file_required');
    }

    if (input.content.length > this.appConfigService.opmlUploadMaxBytes) {
      throw new BadRequestException('opml_file_too_large');
    }

    const lowerFileName = input.fileName.toLowerCase();
    const extensionLooksValid = lowerFileName.endsWith('.opml') || lowerFileName.endsWith('.xml');
    const mimeLooksValid = CreateOpmlImportUseCase.ALLOWED_MIME_TYPES.has(input.mimeType.toLowerCase());

    if (!extensionLooksValid && !mimeLooksValid) {
      throw new BadRequestException('opml_file_invalid_type');
    }
  }
}
