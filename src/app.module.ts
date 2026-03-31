import { Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';

import { AlertsModule } from './modules/alerts/alerts.module';
import { EntriesModule } from './modules/entries/entries.module';
import { FeedsModule } from './modules/feeds/feeds.module';
import { IngestionModule } from './modules/ingestion/ingestion.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ObservabilityModule } from './modules/observability/observability.module';
import { OpmlImportsModule } from './modules/opml-imports/opml-imports.module';
import { RulesModule } from './modules/rules/rules.module';
import { SettingsModule } from './modules/settings/settings.module';
import { configuration } from './shared/config/configuration';
import { AppConfigModule } from './shared/config/app-config.module';
import { AppConfigService } from './shared/config/app-config.service';
import { validateEnv } from './shared/config/env.schema';
import { AuthModule } from './shared/auth/auth.module';
import { LoggerModule } from './shared/logging/logger.module';
import { DatabaseModule } from './infrastructure/persistence/database.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { DashboardAuthModule } from './modules/auth/auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (env) => configuration(validateEnv(env)),
    }),
    AppConfigModule,
    AuthModule,
    LoggerModule,
    DatabaseModule,
    QueueModule,
    DashboardAuthModule,
    FeedsModule,
    RulesModule,
    SettingsModule,
    EntriesModule,
    NotificationsModule,
    AlertsModule,
    ObservabilityModule,
    OpmlImportsModule,
    IngestionModule,
  ],
  providers: [
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        transform: true,
      }),
    },
  ],
})
export class AppModule {}
