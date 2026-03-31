import { Module } from '@nestjs/common';

import { OpmlImportsController } from './http/opml-imports.controller';
import { ConfirmOpmlImportUseCase } from './application/confirm-opml-import.use-case';
import { CreateOpmlImportUseCase } from './application/create-opml-import.use-case';
import { GetOpmlImportStatusUseCase } from './application/get-opml-import-status.use-case';
import { GetOpmlPreviewUseCase } from './application/get-opml-preview.use-case';
import { OpmlImportObservabilityService } from './application/opml-import-observability.service';
import { ProcessOpmlApplyJobUseCase } from './application/process-opml-apply-job.use-case';
import { ProcessOpmlParseJobUseCase } from './application/process-opml-parse-job.use-case';
import { OpmlImportsRepository } from './opml-imports.repository';

@Module({
  controllers: [OpmlImportsController],
  providers: [
    OpmlImportsRepository,
    CreateOpmlImportUseCase,
    GetOpmlPreviewUseCase,
    ConfirmOpmlImportUseCase,
    GetOpmlImportStatusUseCase,
    OpmlImportObservabilityService,
    ProcessOpmlParseJobUseCase,
    ProcessOpmlApplyJobUseCase,
  ],
  exports: [OpmlImportsRepository, ProcessOpmlParseJobUseCase, ProcessOpmlApplyJobUseCase],
})
export class OpmlImportsModule {}
