import { Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { paginatedResponse, successResponse } from '../../../shared/http/response';
import { ApiEnvelopeResponse, ApiStandardErrorResponses } from '../../../shared/http/swagger';
import { AlertDeliveryResultModel, AlertModel } from '../../../shared/http/swagger.models';

import { DeliverAlertUseCase } from '../application/deliver-alert.use-case';
import { GetAlertUseCase } from '../application/get-alert.use-case';
import { ListAlertsUseCase } from '../application/list-alerts.use-case';
import { ListAlertsQueryDto } from '../dto/list-alerts.query';

@ApiTags('Alerts')
@Controller('api/v1/alerts')
export class AlertsController {
  constructor(
    private readonly listAlertsUseCase: ListAlertsUseCase,
    private readonly getAlertUseCase: GetAlertUseCase,
    private readonly deliverAlertUseCase: DeliverAlertUseCase,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List persisted alerts with optional sent-state filter.' })
  @ApiEnvelopeResponse(AlertModel, { status: 200, description: 'Alert list returned successfully.', isArray: true, paginated: true })
  @ApiStandardErrorResponses()
  async list(@Req() request: Request, @Query() query: ListAlertsQueryDto) {
    const result = await this.listAlertsUseCase.execute({
      page: query.page,
      pageSize: query.page_size,
      sent: query.sent,
    });

    return paginatedResponse(request, result.items, query.page, query.page_size, result.total);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get alert detail by id.' })
  @ApiParam({ name: 'id', type: Number, example: 55 })
  @ApiEnvelopeResponse(AlertModel, { status: 200, description: 'Alert returned successfully.' })
  @ApiStandardErrorResponses()
  async getById(@Req() request: Request, @Param('id', ParseIntPipe) id: number) {
    return successResponse(request, await this.getAlertUseCase.execute(id));
  }

  @Post(':id/send')
  @HttpCode(202)
  @ApiOperation({ summary: 'Queue an alert for delivery through the configured notifier.' })
  @ApiParam({ name: 'id', type: Number, example: 55 })
  @ApiEnvelopeResponse(AlertDeliveryResultModel, { status: 202, description: 'Alert delivery was queued successfully.' })
  @ApiStandardErrorResponses()
  async send(@Req() request: Request, @Param('id', ParseIntPipe) id: number) {
    return successResponse(request, await this.deliverAlertUseCase.execute(id, 'manual'));
  }
}
