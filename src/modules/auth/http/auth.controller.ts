import { Controller, Get, Req } from '@nestjs/common';
import { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { AppConfigService } from '../../../shared/config/app-config.service';
import { successResponse } from '../../../shared/http/response';

@ApiTags('Dashboard')
@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly appConfigService: AppConfigService) {}

  @Get('dashboard-config')
  @ApiOperation({ summary: 'Return public dashboard auth config (Clerk publishable key, enabled mode).' })
  getDashboardConfig(@Req() request: Request) {
    const publishableKey = this.appConfigService.clerkPublishableKey;
    return successResponse(request, {
      clerkEnabled: Boolean(publishableKey),
      clerkPublishableKey: publishableKey ?? null,
      authProvider: this.appConfigService.authProvider,
    });
  }
}
