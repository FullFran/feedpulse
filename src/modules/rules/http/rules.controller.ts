import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { paginatedResponse, successResponse } from '../../../shared/http/response';
import { ApiEnvelopeResponse, ApiStandardErrorResponses } from '../../../shared/http/swagger';
import { RuleModel } from '../../../shared/http/swagger.models';
import { resolveTenantIdFromRequest } from '../../../shared/http/tenant-context';
import { BatchCreateRulesUseCase } from '../application/batch-create-rules.use-case';
import { CreateRuleUseCase } from '../application/create-rule.use-case';
import { DisableRuleUseCase } from '../application/disable-rule.use-case';
import { GetRuleUseCase } from '../application/get-rule.use-case';
import { ListRulesUseCase } from '../application/list-rules.use-case';
import { UpdateRuleUseCase } from '../application/update-rule.use-case';
import { BatchCreateRulesDto, BatchCreateRulesResultModel } from '../dto/batch-create-rules.dto';
import { CreateRuleDto } from '../dto/create-rule.dto';
import { ListRulesQueryDto } from '../dto/list-rules.query';
import { UpdateRuleDto } from '../dto/update-rule.dto';

@ApiTags('Rules')
@Controller('api/v1/rules')
export class RulesController {
  constructor(
    private readonly createRuleUseCase: CreateRuleUseCase,
    private readonly listRulesUseCase: ListRulesUseCase,
    private readonly getRuleUseCase: GetRuleUseCase,
    private readonly updateRuleUseCase: UpdateRuleUseCase,
    private readonly disableRuleUseCase: DisableRuleUseCase,
    private readonly batchCreateRulesUseCase: BatchCreateRulesUseCase,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a phrase matching rule (normalized, contiguous containment).' })
  @ApiEnvelopeResponse(RuleModel, { status: 201, description: 'Rule created successfully.' })
  @ApiStandardErrorResponses()
  async create(@Req() request: Request, @Body() payload: CreateRuleDto) {
    const tenantId = resolveTenantIdFromRequest(request);
    const rule = await this.createRuleUseCase.execute({
      tenantId,
      name: payload.name,
      includeKeywords: payload.include_keywords,
      excludeKeywords: payload.exclude_keywords,
      isActive: payload.is_active,
    });

    return successResponse(request, rule);
  }

  /**
   * Declared before `@Get(':id')` on purpose: `batch` is a literal segment and must never be
   * read as a rule id by a future reader of this file, even though the HTTP verbs already
   * keep the two routes apart.
   */
  @Post('batch')
  @ApiOperation({
    summary: 'Create up to 50 rules in one call. Create-only: existing names are skipped, never overwritten.',
    description:
      'Pairs with OPML bulk import: after importing dozens of feeds, the matching rule set can be sent in one request. ' +
      'The response accounts for every submitted name exactly once, as created, skipped (already existed) or duplicate (listed twice in this request).',
  })
  @ApiEnvelopeResponse(BatchCreateRulesResultModel, {
    status: 201,
    description: 'Batch processed. Inspect the body to see which rules were created and which were skipped.',
  })
  @ApiStandardErrorResponses()
  async batchCreate(@Req() request: Request, @Body() payload: BatchCreateRulesDto) {
    const tenantId = resolveTenantIdFromRequest(request);
    const result = await this.batchCreateRulesUseCase.execute({
      tenantId,
      rules: payload.rules.map((item) => ({
        name: item.name,
        includeKeywords: item.include_keywords,
        excludeKeywords: item.exclude_keywords ?? [],
        isActive: item.is_active ?? true,
      })),
    });

    return successResponse(request, result);
  }

  @Get()
  @ApiOperation({ summary: 'List rules with active-state and text filters.' })
  @ApiEnvelopeResponse(RuleModel, {
    status: 200,
    description: 'Rule list returned successfully.',
    isArray: true,
    paginated: true,
  })
  @ApiStandardErrorResponses()
  async list(@Req() request: Request, @Query() query: ListRulesQueryDto) {
    const tenantId = resolveTenantIdFromRequest(request);
    const result = await this.listRulesUseCase.execute({
      tenantId,
      page: query.page,
      pageSize: query.page_size,
      isActive: query.is_active,
      query: query.q,
    });

    return paginatedResponse(request, result.items, query.page, query.page_size, result.total);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get rule detail by id.' })
  @ApiParam({ name: 'id', type: Number, example: 7 })
  @ApiEnvelopeResponse(RuleModel, { status: 200, description: 'Rule returned successfully.' })
  @ApiStandardErrorResponses()
  async getById(@Req() request: Request, @Param('id', ParseIntPipe) id: number) {
    const tenantId = resolveTenantIdFromRequest(request);
    return successResponse(request, await this.getRuleUseCase.execute(id, tenantId));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a phrase matching rule (normalized, contiguous containment).' })
  @ApiParam({ name: 'id', type: Number, example: 7 })
  @ApiEnvelopeResponse(RuleModel, { status: 200, description: 'Rule updated successfully.' })
  @ApiStandardErrorResponses()
  async update(@Req() request: Request, @Param('id', ParseIntPipe) id: number, @Body() payload: UpdateRuleDto) {
    const tenantId = resolveTenantIdFromRequest(request);
    return successResponse(
      request,
      await this.updateRuleUseCase.execute({
        tenantId,
        id,
        name: payload.name,
        includeKeywords: payload.include_keywords,
        excludeKeywords: payload.exclude_keywords,
        isActive: payload.is_active,
      }),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Safely disable a rule without deleting alert history.' })
  @ApiParam({ name: 'id', type: Number, example: 7 })
  @ApiNoContentResponse({ description: 'Rule was disabled successfully.' })
  @ApiStandardErrorResponses()
  async remove(@Req() request: Request, @Param('id', ParseIntPipe) id: number): Promise<void> {
    const tenantId = resolveTenantIdFromRequest(request);
    await this.disableRuleUseCase.execute(id, tenantId);
  }
}
