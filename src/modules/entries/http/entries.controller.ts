import { Controller, Get, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { paginatedResponse } from '../../../shared/http/response';
import { ApiEnvelopeResponse, ApiStandardErrorResponses } from '../../../shared/http/swagger';
import { EntryModel } from '../../../shared/http/swagger.models';
import { resolveTenantIdFromRequest } from '../../../shared/http/tenant-context';

import { ListEntriesUseCase } from '../application/list-entries.use-case';
import { ListEntriesQueryDto } from '../dto/list-entries.query';

@ApiTags('Entries')
@Controller('api/v1/entries')
export class EntriesController {
  constructor(private readonly listEntriesUseCase: ListEntriesUseCase) {}

  @Get()
  @ApiOperation({ summary: 'List ingested feed entries with feed and text filters.' })
  @ApiEnvelopeResponse(EntryModel, { status: 200, description: 'Entry list returned successfully.', isArray: true, paginated: true })
  @ApiStandardErrorResponses()
  async list(@Req() request: Request, @Query() query: ListEntriesQueryDto) {
    const tenantId = resolveTenantIdFromRequest(request);
    const result = await this.listEntriesUseCase.execute({
      tenantId,
      page: query.page,
      pageSize: query.page_size,
      feedId: query.feed_id,
      search: query.search,
      from: query.from,
      to: query.to,
    });

    return paginatedResponse(request, result.items, query.page, query.page_size, result.total);
  }
}
