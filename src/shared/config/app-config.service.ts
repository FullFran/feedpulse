import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AppConfiguration } from './configuration';

@Injectable()
export class AppConfigService {
  constructor(@Inject(ConfigService) private readonly configService: ConfigService<AppConfiguration, true>) {}

  get port(): number {
    return this.configService.get<number>('port', { infer: true });
  }

  get databaseUrl(): string {
    return this.configService.get<string>('databaseUrl', { infer: true });
  }

  get redisUrl(): string {
    return this.configService.get<string>('redisUrl', { infer: true });
  }

  get webhookNotifierUrl(): string | undefined {
    return this.configService.get<string>('webhookNotifierUrl', { infer: true });
  }

  get webhookNotifierTimeoutMs(): number {
    return this.configService.get<number>('webhookNotifierTimeoutMs', { infer: true });
  }

  get schedulerTickMs(): number {
    return this.configService.get<number>('schedulerTickMs', { infer: true });
  }

  get schedulerBatchSize(): number {
    return this.configService.get<number>('schedulerBatchSize', { infer: true });
  }

  get workerConcurrency(): number {
    return this.configService.get<number>('workerConcurrency', { infer: true });
  }

  get fetchTimeoutMs(): number {
    return this.configService.get<number>('fetchTimeoutMs', { infer: true });
  }

  get nodeEnv(): string {
    return this.configService.get<string>('nodeEnv', { infer: true });
  }

  get logLevel(): string {
    return this.configService.get<string>('logLevel', { infer: true });
  }

  get rateLimitRequestsPerSecond(): number {
    return this.configService.get<number>('rateLimitRequestsPerSecond', { infer: true });
  }

  get rateLimitMaxBackoffMs(): number {
    return this.configService.get<number>('rateLimitMaxBackoffMs', { infer: true });
  }

  get rateLimitBaseBackoffMs(): number {
    return this.configService.get<number>('rateLimitBaseBackoffMs', { infer: true });
  }

  get workerMetricsPort(): number {
    return this.configService.get<number>('workerMetricsPort', { infer: true });
  }
}
