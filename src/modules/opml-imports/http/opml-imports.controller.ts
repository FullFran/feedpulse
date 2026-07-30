import {
  BadRequestException,
  CallHandler,
  Controller,
  ExecutionContext,
  Get,
  HttpCode,
  Injectable,
  NestInterceptor,
  Param,
  ParseIntPipe,
  PayloadTooLargeException,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { paginatedResponse, successResponse } from '../../../shared/http/response';
import { ApiStandardErrorResponses } from '../../../shared/http/swagger';
import { resolveTenantIdFromRequest } from '../../../shared/http/tenant-context';
import { ConfirmOpmlImportUseCase } from '../application/confirm-opml-import.use-case';
import { CreateOpmlImportUseCase } from '../application/create-opml-import.use-case';
import { GetOpmlImportStatusUseCase } from '../application/get-opml-import-status.use-case';
import { GetOpmlPreviewUseCase } from '../application/get-opml-preview.use-case';
import { OpmlPreviewQueryDto } from '../dto/opml-preview.query';

/** Mirrors OPML_UPLOAD_MAX_BYTES in env.schema.ts. */
const DEFAULT_OPML_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The multipart interceptor is built outside the DI container and therefore cannot
 * read AppConfigService. It reads the raw environment variable instead, lazily, so
 * the value is resolved when the interceptor instance is constructed rather than at
 * decoration time.
 */
export function resolveOpmlUploadMaxBytes(): number {
  const raw = Number(process.env.OPML_UPLOAD_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_OPML_UPLOAD_MAX_BYTES;
}

/**
 * Translates multer's transport-level failures into the OPML error contract.
 * Nest maps multer's LIMIT_FILE_SIZE to a 413 PayloadTooLargeException; the API has
 * always answered 400 `opml_file_too_large` for oversized OPML files, so the early
 * abort must not change the contract.
 */
function mapUploadTransportError(error: unknown): unknown {
  if (error instanceof PayloadTooLargeException) {
    return new BadRequestException('opml_file_too_large');
  }

  if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'LIMIT_FILE_SIZE') {
    return new BadRequestException('opml_file_too_large');
  }

  return error;
}

/**
 * Runs outside the multipart interceptor so it can rewrite the transport error it
 * raises. Registered first in @UseInterceptors, which makes it the outer handler.
 */
@Injectable()
export class OpmlUploadErrorInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(catchError((error: unknown) => throwError(() => mapUploadTransportError(error))));
  }
}

/**
 * Caps the upload at the stream level so an oversized body is aborted while it is
 * still being received, instead of being fully buffered and rejected afterwards.
 * The downstream size check in CreateOpmlImportUseCase stays in place as defence
 * in depth.
 */
const OpmlFileInterceptor = FileInterceptor('file', {
  // Lazily resolved: multer reads these options when the interceptor is instantiated,
  // which happens after the configuration environment has been loaded.
  get limits() {
    return { fileSize: resolveOpmlUploadMaxBytes(), files: 1, fields: 5 };
  },
});

@ApiTags('OPML Imports')
@Controller('api/v1/opml/imports')
export class OpmlImportsController {
  constructor(
    private readonly createOpmlImportUseCase: CreateOpmlImportUseCase,
    private readonly getOpmlPreviewUseCase: GetOpmlPreviewUseCase,
    private readonly confirmOpmlImportUseCase: ConfirmOpmlImportUseCase,
    private readonly getOpmlImportStatusUseCase: GetOpmlImportStatusUseCase,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Upload OPML file and create asynchronous parse-preview job.' })
  @ApiConsumes('multipart/form-data')
  @ApiStandardErrorResponses()
  @UseInterceptors(new OpmlUploadErrorInterceptor(), OpmlFileInterceptor)
  async upload(
    @Req() request: Request,
    @UploadedFile() file?: { originalname: string; mimetype: string; buffer: Buffer },
  ) {
    const tenantId = resolveTenantIdFromRequest(request);
    if (!file) {
      throw new BadRequestException('opml_file_required');
    }

    const created = await this.createOpmlImportUseCase.execute({
      tenantId,
      fileName: file.originalname,
      mimeType: file.mimetype,
      content: file.buffer,
    });

    return successResponse(request, created);
  }

  @Get(':id/preview')
  @ApiOperation({ summary: 'Get OPML preview with counters and paginated items.' })
  @ApiParam({ name: 'id', type: Number, example: 1 })
  @ApiStandardErrorResponses()
  async preview(@Req() request: Request, @Param('id', ParseIntPipe) id: number, @Query() query: OpmlPreviewQueryDto) {
    const tenantId = resolveTenantIdFromRequest(request);
    const result = await this.getOpmlPreviewUseCase.execute({
      tenantId,
      importId: id,
      page: query.page,
      pageSize: query.page_size,
    });

    return {
      ...paginatedResponse(request, result.items, query.page, query.page_size, result.total),
      summary: result.import,
    };
  }

  @Post(':id/confirm')
  @HttpCode(202)
  @ApiOperation({ summary: 'Confirm OPML import (idempotent) and enqueue apply job.' })
  @ApiParam({ name: 'id', type: Number, example: 1 })
  @ApiStandardErrorResponses()
  async confirm(@Req() request: Request, @Param('id', ParseIntPipe) id: number) {
    const tenantId = resolveTenantIdFromRequest(request);
    return successResponse(request, await this.confirmOpmlImportUseCase.execute(id, tenantId));
  }

  @Get(':id/status')
  @ApiOperation({ summary: 'Get import status and progress with partial-failure visibility.' })
  @ApiParam({ name: 'id', type: Number, example: 1 })
  @ApiStandardErrorResponses()
  async status(@Req() request: Request, @Param('id', ParseIntPipe) id: number) {
    const tenantId = resolveTenantIdFromRequest(request);
    return successResponse(request, await this.getOpmlImportStatusUseCase.execute(id, tenantId));
  }
}
