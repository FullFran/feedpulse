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

  get resendApiKey(): string | undefined {
    return this.configService.get<string>('resendApiKey', { infer: true });
  }

  get resendFromEmail(): string | undefined {
    return this.configService.get<string>('resendFromEmail', { infer: true });
  }

  get schedulerTickMs(): number {
    return this.configService.get<number>('schedulerTickMs', { infer: true });
  }

  get schedulerBatchSize(): number {
    const configured = this.configService.get<number>('schedulerBatchSize', { infer: true });
    return Math.max(1, Math.min(configured, 40));
  }

  get workerConcurrency(): number {
    const configured = this.configService.get<number>('workerConcurrency', { infer: true });
    return Math.max(1, Math.min(configured, 3));
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

  get opmlUploadMaxBytes(): number {
    return this.configService.get<number>('opmlUploadMaxBytes', { infer: true });
  }

  get opmlInitialJitterMaxSeconds(): number {
    return this.configService.get<number>('opmlInitialJitterMaxSeconds', { infer: true });
  }

  get agentInterfaceV1(): boolean {
    return this.configService.get<boolean>('agentInterfaceV1', { infer: true });
  }

  get tuiEnabled(): boolean {
    return this.configService.get<boolean>('tuiEnabled', { infer: true });
  }

  get enableAuth(): boolean {
    return this.configService.get<boolean>('enableAuth', { infer: true });
  }

  get authProvider(): string {
    return this.configService.get<string>('authProvider', { infer: true });
  }

  get clerkSecretKey(): string | undefined {
    return this.configService.get<string>('clerkSecretKey', { infer: true });
  }

  get clerkPublishableKey(): string | undefined {
    return this.configService.get<string>('clerkPublishableKey', { infer: true });
  }

  get clerkApiUrl(): string {
    return this.configService.get<string>('clerkApiUrl', { infer: true });
  }
}
