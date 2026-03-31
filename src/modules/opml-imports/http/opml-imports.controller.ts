import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { paginatedResponse, successResponse } from '../../../shared/http/response';
import { ApiStandardErrorResponses } from '../../../shared/http/swagger';

import { ConfirmOpmlImportUseCase } from '../application/confirm-opml-import.use-case';
import { CreateOpmlImportUseCase } from '../application/create-opml-import.use-case';
import { GetOpmlImportStatusUseCase } from '../application/get-opml-import-status.use-case';
import { GetOpmlPreviewUseCase } from '../application/get-opml-preview.use-case';
import { OpmlPreviewQueryDto } from '../dto/opml-preview.query';

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
  @UseInterceptors(FileInterceptor('file'))
  async upload(@Req() request: Request, @UploadedFile() file?: { originalname: string; mimetype: string; buffer: Buffer }) {
    if (!file) {
      throw new BadRequestException('opml_file_required');
    }

    const created = await this.createOpmlImportUseCase.execute({
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
    const result = await this.getOpmlPreviewUseCase.execute({
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
    return successResponse(request, await this.confirmOpmlImportUseCase.execute(id));
  }

  @Get(':id/status')
  @ApiOperation({ summary: 'Get import status and progress with partial-failure visibility.' })
  @ApiParam({ name: 'id', type: Number, example: 1 })
  @ApiStandardErrorResponses()
  async status(@Req() request: Request, @Param('id', ParseIntPipe) id: number) {
    return successResponse(request, await this.getOpmlImportStatusUseCase.execute(id));
  }
}
