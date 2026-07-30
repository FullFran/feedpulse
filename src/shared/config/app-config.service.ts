import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfiguration } from './configuration';

@Injectable()
export class AppConfigService {
  constructor(@Inject(ConfigService) private readonly configService: ConfigService<AppConfiguration, true>) {}

  /**
   * Single typed read against the validated configuration.
   *
   * Passing an explicit generic — `get<number>('port', { infer: true })`, which
   * every getter here used to do — selects the `ConfigService` overload that
   * returns `any`, so the declared return type was never actually checked
   * against the configuration and each getter carried an `no-unsafe-return`
   * warning. Letting the key drive the inference instead resolves the value
   * through `PathValue`, so a mistyped key or a getter whose declared type
   * disagrees with `AppConfiguration` is now a compile error.
   */
  private read<K extends keyof AppConfiguration>(key: K): AppConfiguration[K] {
    return this.configService.get(key, { infer: true });
  }

  get port(): number {
    return this.read('port');
  }

  get databaseUrl(): string {
    return this.read('databaseUrl');
  }

  get redisUrl(): string {
    return this.read('redisUrl');
  }

  get webhookNotifierUrl(): string | undefined {
    return this.read('webhookNotifierUrl');
  }

  get webhookNotifierTimeoutMs(): number {
    return this.read('webhookNotifierTimeoutMs');
  }

  get resendApiKey(): string | undefined {
    return this.read('resendApiKey');
  }

  get resendFromEmail(): string | undefined {
    return this.read('resendFromEmail');
  }

  get resendDailyLimit(): number {
    return this.read('resendDailyLimit');
  }

  get telegramBotToken(): string | undefined {
    return this.read('telegramBotToken');
  }

  get tenantSecretsMasterKey(): string | undefined {
    return this.read('tenantSecretsMasterKey');
  }

  get telegramApiUrl(): string {
    return this.read('telegramApiUrl');
  }

  get schedulerTickMs(): number {
    return this.read('schedulerTickMs');
  }

  get schedulerBatchSize(): number {
    return Math.max(1, Math.min(this.read('schedulerBatchSize'), 40));
  }

  get schedulerStuckFeedThresholdSeconds(): number {
    return this.read('schedulerStuckFeedThresholdSeconds');
  }

  get workerConcurrency(): number {
    return Math.max(1, Math.min(this.read('workerConcurrency'), 3));
  }

  get fetchTimeoutMs(): number {
    return this.read('fetchTimeoutMs');
  }

  get nodeEnv(): string {
    return this.read('nodeEnv');
  }

  get logLevel(): string {
    return this.read('logLevel');
  }

  get shutdownTimeoutMs(): number {
    return this.read('shutdownTimeoutMs');
  }

  get rateLimitRequestsPerSecond(): number {
    return this.read('rateLimitRequestsPerSecond');
  }

  get rateLimitMaxBackoffMs(): number {
    return this.read('rateLimitMaxBackoffMs');
  }

  get rateLimitBaseBackoffMs(): number {
    return this.read('rateLimitBaseBackoffMs');
  }

  get rateLimitTtlSeconds(): number {
    return this.read('rateLimitTtlSeconds');
  }

  get rateLimitMaxRequests(): number {
    return this.read('rateLimitMaxRequests');
  }

  get rateLimitWriteMaxRequests(): number {
    return this.read('rateLimitWriteMaxRequests');
  }

  get maxFeedsPerTenant(): number {
    return this.read('maxFeedsPerTenant');
  }

  get workerMetricsPort(): number {
    return this.read('workerMetricsPort');
  }

  get workerMetricsBind(): string {
    return this.read('workerMetricsBind');
  }

  get metricsAuthToken(): string | undefined {
    return this.read('metricsAuthToken');
  }

  get corsOrigins(): string[] {
    return this.read('corsOrigins');
  }

  get enableSwagger(): boolean {
    return this.read('enableSwagger');
  }

  get allowPrivateFeedHosts(): boolean {
    return this.read('allowPrivateFeedHosts');
  }

  get feedFetchMaxBytes(): number {
    return this.read('feedFetchMaxBytes');
  }

  get opmlUploadMaxBytes(): number {
    return this.read('opmlUploadMaxBytes');
  }

  get opmlInitialJitterMaxSeconds(): number {
    return this.read('opmlInitialJitterMaxSeconds');
  }

  get agentInterfaceV1(): boolean {
    return this.read('agentInterfaceV1');
  }

  get tuiEnabled(): boolean {
    return this.read('tuiEnabled');
  }

  get enableAuth(): boolean {
    return this.read('enableAuth');
  }

  get authProvider(): string {
    return this.read('authProvider');
  }

  get bootstrapApiKey(): string | undefined {
    return this.read('bootstrapApiKey');
  }

  get bootstrapApiKeyTenantId(): string {
    return this.read('bootstrapApiKeyTenantId');
  }

  get clerkSecretKey(): string | undefined {
    return this.read('clerkSecretKey');
  }

  get clerkPublishableKey(): string | undefined {
    return this.read('clerkPublishableKey');
  }

  get clerkApiUrl(): string {
    return this.read('clerkApiUrl');
  }
}
