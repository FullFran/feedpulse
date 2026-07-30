import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { paginatedResponse, successResponse } from '../../../shared/http/response';
import { ApiEnvelopeResponse, ApiStandardErrorResponses } from '../../../shared/http/swagger';
import { FeedCheckNowResultModel, FeedModel } from '../../../shared/http/swagger.models';
import { resolveTenantIdFromRequest } from '../../../shared/http/tenant-context';
import { CheckFeedNowUseCase } from '../application/check-feed-now.use-case';
import { DisableFeedUseCase } from '../application/disable-feed.use-case';
import { GetFeedUseCase } from '../application/get-feed.use-case';
import { ListFeedsUseCase } from '../application/list-feeds.use-case';
import { RegisterFeedUseCase } from '../application/register-feed.use-case';
import { UpdateFeedUseCase } from '../application/update-feed.use-case';
import { ValidateFeedUrlUseCase } from '../application/validate-feed-url.use-case';
import { CreateFeedDto } from '../dto/create-feed.dto';
import { ListFeedsQueryDto } from '../dto/list-feeds.query';
import { UpdateFeedDto } from '../dto/update-feed.dto';
import { ValidateFeedUrlDto, ValidateFeedUrlResultModel } from '../dto/validate-feed-url.dto';

@ApiTags('Feeds')
@Controller('api/v1/feeds')
export class FeedsController {
  constructor(
    private readonly registerFeedUseCase: RegisterFeedUseCase,
    private readonly listFeedsUseCase: ListFeedsUseCase,
    private readonly getFeedUseCase: GetFeedUseCase,
    private readonly updateFeedUseCase: UpdateFeedUseCase,
    private readonly disableFeedUseCase: DisableFeedUseCase,
    private readonly checkFeedNowUseCase: CheckFeedNowUseCase,
    private readonly validateFeedUrlUseCase: ValidateFeedUrlUseCase,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Register a feed for monitoring.' })
  @ApiEnvelopeResponse(FeedModel, { status: 201, description: 'Feed created successfully.' })
  @ApiStandardErrorResponses()
  async create(@Req() request: Request, @Body() payload: CreateFeedDto) {
    const tenantId = resolveTenantIdFromRequest(request);
    const feed = await this.registerFeedUseCase.execute({
      tenantId,
      url: payload.url,
      pollIntervalSeconds: payload.poll_interval_seconds,
      status: payload.status,
    });

    return successResponse(request, feed);
  }

  // Declared before the `:id` routes so the literal segment can never be shadowed
  // by a future `@Post(':id')` handler.
  @Post('validate')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Check what a feed URL contains before registering it.',
    description:
      'Fetches an arbitrary http(s) URL once, parses it as a feed and reports the title, item count and up to ' +
      'three recent items, so the caller sees what would be matched before committing. Transport and parse ' +
      'problems are reported in `error` using a closed vocabulary with a 200 response; upstream error text and ' +
      'response bodies are never echoed. Private, loopback and link-local targets are refused without issuing a ' +
      'request. Subject to the tighter write/probe rate limit.',
  })
  @ApiEnvelopeResponse(ValidateFeedUrlResultModel, { status: 200, description: 'Probe completed.' })
  @ApiStandardErrorResponses()
  async validate(@Req() request: Request, @Body() payload: ValidateFeedUrlDto) {
    const tenantId = resolveTenantIdFromRequest(request);
    return successResponse(request, await this.validateFeedUrlUseCase.execute({ tenantId, url: payload.url }));
  }

  @Get()
  @ApiOperation({ summary: 'List feeds with simple status and text filters.' })
  @ApiEnvelopeResponse(FeedModel, {
    status: 200,
    description: 'Feed list returned successfully.',
    isArray: true,
    paginated: true,
  })
  @ApiStandardErrorResponses()
  async list(@Req() request: Request, @Query() query: ListFeedsQueryDto) {
    const tenantId = resolveTenantIdFromRequest(request);
    const result = await this.listFeedsUseCase.execute({
      tenantId,
      status: query.status,
      query: query.q,
      page: query.page,
      pageSize: query.page_size,
    });

    return paginatedResponse(request, result.items, query.page, query.page_size, result.total);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get feed detail by id.' })
  @ApiParam({ name: 'id', type: Number, example: 101 })
  @ApiEnvelopeResponse(FeedModel, { status: 200, description: 'Feed returned successfully.' })
  @ApiStandardErrorResponses()
  async getById(@Req() request: Request, @Param('id', ParseIntPipe) id: number) {
    const tenantId = resolveTenantIdFromRequest(request);
    return successResponse(request, await this.getFeedUseCase.execute(id, tenantId));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update feed polling configuration or status.' })
  @ApiParam({ name: 'id', type: Number, example: 101 })
  @ApiEnvelopeResponse(FeedModel, { status: 200, description: 'Feed updated successfully.' })
  @ApiStandardErrorResponses()
  async update(@Req() request: Request, @Param('id', ParseIntPipe) id: number, @Body() payload: UpdateFeedDto) {
    const tenantId = resolveTenantIdFromRequest(request);
    return successResponse(
      request,
      await this.updateFeedUseCase.execute({
        tenantId,
        id,
        status: payload.status,
        pollIntervalSeconds: payload.poll_interval_seconds,
      }),
    );
  }

  @Post(':id/check-now')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Queue an immediate feed check without waiting for the scheduler tick.',
    description:
      'Returns `queued` when a new job was accepted and `already_queued` when a fetch for this feed is already in flight.',
  })
  @ApiParam({ name: 'id', type: Number, example: 101 })
  @ApiEnvelopeResponse(FeedCheckNowResultModel, { status: 202, description: 'Feed check request was accepted.' })
  @ApiStandardErrorResponses()
  async checkNow(@Req() request: Request, @Param('id', ParseIntPipe) id: number) {
    const tenantId = resolveTenantIdFromRequest(request);
    return successResponse(request, await this.checkFeedNowUseCase.execute(id, tenantId));
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Safely disable a feed without deleting persisted history.' })
  @ApiParam({ name: 'id', type: Number, example: 101 })
  @ApiNoContentResponse({ description: 'Feed was disabled successfully.' })
  @ApiStandardErrorResponses()
  async remove(@Req() request: Request, @Param('id', ParseIntPipe) id: number): Promise<void> {
    const tenantId = resolveTenantIdFromRequest(request);
    await this.disableFeedUseCase.execute(id, tenantId);
  }
}
