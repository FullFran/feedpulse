import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { ApiNoContentResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { paginatedResponse, successResponse } from '../../../shared/http/response';
import { ApiEnvelopeResponse, ApiStandardErrorResponses } from '../../../shared/http/swagger';
import { RuleModel } from '../../../shared/http/swagger.models';

import { CreateRuleUseCase } from '../application/create-rule.use-case';
import { DisableRuleUseCase } from '../application/disable-rule.use-case';
import { GetRuleUseCase } from '../application/get-rule.use-case';
import { ListRulesUseCase } from '../application/list-rules.use-case';
import { UpdateRuleUseCase } from '../application/update-rule.use-case';
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
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a keyword matching rule.' })
  @ApiEnvelopeResponse(RuleModel, { status: 201, description: 'Rule created successfully.' })
  @ApiStandardErrorResponses()
  async create(@Req() request: Request, @Body() payload: CreateRuleDto) {
    const rule = await this.createRuleUseCase.execute({
      name: payload.name,
      includeKeywords: payload.include_keywords,
      excludeKeywords: payload.exclude_keywords,
      isActive: payload.is_active,
    });

    return successResponse(request, rule);
  }

  @Get()
  @ApiOperation({ summary: 'List rules with active-state and text filters.' })
  @ApiEnvelopeResponse(RuleModel, { status: 200, description: 'Rule list returned successfully.', isArray: true, paginated: true })
  @ApiStandardErrorResponses()
  async list(@Req() request: Request, @Query() query: ListRulesQueryDto) {
    const result = await this.listRulesUseCase.execute({
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
    return successResponse(request, await this.getRuleUseCase.execute(id));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a keyword matching rule.' })
  @ApiParam({ name: 'id', type: Number, example: 7 })
  @ApiEnvelopeResponse(RuleModel, { status: 200, description: 'Rule updated successfully.' })
  @ApiStandardErrorResponses()
  async update(@Req() request: Request, @Param('id', ParseIntPipe) id: number, @Body() payload: UpdateRuleDto) {
    return successResponse(
      request,
      await this.updateRuleUseCase.execute({
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
  async remove(@Param('id', ParseIntPipe) id: number): Promise<void> {
    await this.disableRuleUseCase.execute(id);
  }
}
