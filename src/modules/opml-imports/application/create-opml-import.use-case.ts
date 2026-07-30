import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
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

  async execute(input: {
    tenantId?: string;
    fileName: string;
    mimeType: string;
    content: Buffer;
  }): Promise<{ id: string; status: string; parseQueued: boolean }> {
    this.validateUpload(input);

    const sourceChecksum = createHash('sha256').update(input.content).digest('hex');
    const created = await this.opmlImportsRepository.createImport({
      tenantId: input.tenantId ?? 'legacy',
      fileName: input.fileName,
      fileSizeBytes: input.content.length,
      sourceChecksum,
    });

    // KNOWN LIMITATION: the whole OPML document travels as a BullMQ payload, so a
    // multi-MB import becomes a multi-MB Redis value. The fix is to persist the
    // document in `opml_imports` and enqueue only `importId`, which needs a schema
    // migration plus changes in OpmlParsePreviewJobData and ProcessOpmlParseJobUseCase.
    // Until then, OPML_UPLOAD_MAX_BYTES (enforced at the multipart layer) is what
    // bounds the payload size.
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

  /**
   * Defence in depth. The multipart interceptor already aborts oversized uploads at
   * the stream level; this check still runs so the rule holds for any caller that
   * reaches the use case without going through the HTTP edge.
   */
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
