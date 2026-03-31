import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { successResponse } from '../../../shared/http/response';
import { ApiEnvelopeResponse, ApiStandardErrorResponses } from '../../../shared/http/swagger';
import { TenantSettingsModel } from '../../../shared/http/swagger.models';
import { resolveTenantIdFromRequest } from '../../../shared/http/tenant-context';

import { GetSettingsUseCase } from '../application/get-settings.use-case';
import { UpdateSettingsUseCase } from '../application/update-settings.use-case';
import { UpdateSettingsDto } from '../dto/update-settings.dto';

@ApiTags('Settings')
@Controller('api/v1/settings')
export class SettingsController {
  constructor(
    private readonly getSettingsUseCase: GetSettingsUseCase,
    private readonly updateSettingsUseCase: UpdateSettingsUseCase,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Read current tenant settings for dashboard integrations.' })
  @ApiEnvelopeResponse(TenantSettingsModel, { status: 200, description: 'Settings returned successfully.' })
  @ApiStandardErrorResponses()
  async get(@Req() request: Request) {
    const tenantId = resolveTenantIdFromRequest(request);
    const settings = await this.getSettingsUseCase.execute(tenantId);
    return successResponse(request, settings);
  }

  @Put()
  @ApiOperation({ summary: 'Update current tenant settings (webhook URL, etc.).' })
  @ApiEnvelopeResponse(TenantSettingsModel, { status: 200, description: 'Settings updated successfully.' })
  @ApiStandardErrorResponses()
  async update(@Req() request: Request, @Body() payload: UpdateSettingsDto) {
    const tenantId = resolveTenantIdFromRequest(request);
    const webhookNotifierUrl = payload.webhook_notifier_url === undefined ? null : payload.webhook_notifier_url;
    const settings = await this.updateSettingsUseCase.execute({
      tenantId,
      webhookNotifierUrl,
    });

    return successResponse(request, settings);
  }
}
