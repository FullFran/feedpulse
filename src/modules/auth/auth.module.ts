import { Module } from '@nestjs/common';

import { AuthController } from './http/auth.controller';

@Module({
  controllers: [AuthController],
})
export class DashboardAuthModule {}
