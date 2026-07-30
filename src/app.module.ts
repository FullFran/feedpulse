import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { DatabaseModule } from './infrastructure/persistence/database.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { AlertsModule } from './modules/alerts/alerts.module';
import { DashboardAuthModule } from './modules/auth/auth.module';
import { EntriesModule } from './modules/entries/entries.module';
import { FeedsModule } from './modules/feeds/feeds.module';
import { IngestionModule } from './modules/ingestion/ingestion.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ObservabilityModule } from './modules/observability/observability.module';
import { OpmlImportsModule } from './modules/opml-imports/opml-imports.module';
import { RulesModule } from './modules/rules/rules.module';
import { SettingsModule } from './modules/settings/settings.module';
import { AuthGuard } from './shared/auth/auth.guard';
import { AuthModule } from './shared/auth/auth.module';
import { AppConfigModule } from './shared/config/app-config.module';
import { configuration } from './shared/config/configuration';
import { validateEnv } from './shared/config/env.schema';
import { AllExceptionsFilter } from './shared/filters/all-exceptions.filter';
import { RateLimitModule } from './shared/http/throttler.module';
import { RequestIdInterceptor } from './shared/interceptors/request-id.interceptor';
import { LoggerModule } from './shared/logging/logger.module';

@Module({
  // Module order is load-bearing: Nest tears modules down in REVERSE registration
  // order, so IngestionModule must stay LAST. That is what lets WorkerRunner drain
  // in-flight BullMQ jobs before QueueModule closes Redis and DatabaseModule closes
  // the pg pool. Moving IngestionModule earlier silently drops in-flight jobs.
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
    // Inbound per-tenant HTTP rate limiting. It binds its own APP_GUARD from
    // inside the module on purpose: Nest collects the host module's providers
    // before those of the modules it imports, so RateLimitGuard is guaranteed to
    // run AFTER the AuthGuard declared directly below and therefore sees a
    // populated `request.tenantId`. Do NOT add a second APP_GUARD entry for it
    // to `providers` — that would charge every request twice. It also needs
    // REDIS_CONNECTION, so it must stay after QueueModule.
    RateLimitModule,
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
    // Catch-all filter: every failure below leaves as the JSON error envelope.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Assigns/echoes `x-request-id` before any handler runs, so the id exists for
    // success responses; the filter re-applies it on the error path, which Nest
    // reaches without ever entering the interceptor chain.
    { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
    // Authentication. As a guard (rather than raw Express middleware) rejections
    // flow through AllExceptionsFilter instead of Express' HTML `finalhandler`.
    { provide: APP_GUARD, useClass: AuthGuard },
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
