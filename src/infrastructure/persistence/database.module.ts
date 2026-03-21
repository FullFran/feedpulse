import { Global, Module } from '@nestjs/common';
import { Pool } from 'pg';

import { AppConfigService } from '../../shared/config/app-config.service';

import { DATABASE_POOL } from './database.constants';
import { DatabaseService } from './database.service';
import { ReadinessService } from './readiness.service';

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      inject: [AppConfigService],
      useFactory: (configService: AppConfigService) =>
        new Pool({
          connectionString: configService.databaseUrl,
        }),
    },
    DatabaseService,
    ReadinessService,
  ],
  exports: [DATABASE_POOL, DatabaseService, ReadinessService],
})
export class DatabaseModule {}
