import { Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { ApiKeysRepository } from '../../modules/auth/api-keys.repository';
import { AppConfigService } from '../config/app-config.service';
import {
  LEGACY_TENANT_ID,
  deriveTenantIdFromClerkPrincipal,
  getApiKeyFromRequest,
  getBearerTokenFromRequest,
} from '../http/tenant-context';
import { ClerkSessionVerifierService } from './clerk-session-verifier.service';

export const KNOWN_AUTH_PROVIDERS = ['api_key', 'clerk', 'clerk_api_key'] as const;

export type KnownAuthProvider = (typeof KNOWN_AUTH_PROVIDERS)[number];

function looksLikeJwt(value: string): boolean {
  return value.split('.').length === 3;
}

@Injectable()
export class HttpAuthService implements OnModuleInit {
  constructor(
    private readonly appConfigService: AppConfigService,
    private readonly clerkSessionVerifier: ClerkSessionVerifierService,
    private readonly apiKeysRepository: ApiKeysRepository,
  ) {}

  /**
   * An unrecognized AUTH_PROVIDER used to silently disable both authentication paths, turning a
   * typo into "every request is rejected at runtime". Fail loudly at startup instead.
   */
  onModuleInit(): void {
    const provider = this.normalizedProvider;
    if (!(KNOWN_AUTH_PROVIDERS as readonly string[]).includes(provider)) {
      throw new Error(
        `Unrecognized AUTH_PROVIDER "${this.appConfigService.authProvider}". Expected one of: ${KNOWN_AUTH_PROVIDERS.join(', ')}.`,
      );
    }
  }

  private get normalizedProvider(): string {
    return this.appConfigService.authProvider.trim().toLowerCase();
  }

  private get supportsApiKey(): boolean {
    const provider = this.normalizedProvider;
    return provider === 'api_key' || provider === 'clerk_api_key';
  }

  private get supportsClerk(): boolean {
    const provider = this.normalizedProvider;
    return provider === 'clerk' || provider === 'clerk_api_key';
  }

  async authenticateRequest(request: Request): Promise<void> {
    // Development mode: authentication is explicitly disabled, so every request belongs to the
    // single legacy tenant. This is the ONLY bypass, it is driven by configuration (never by
    // NODE_ENV), and the env schema refuses to boot a production process with ENABLE_AUTH=false.
    if (!this.appConfigService.enableAuth) {
      request.tenantId = LEGACY_TENANT_ID;
      return;
    }

    if (request.tenantId) {
      return;
    }

    const apiKey = getApiKeyFromRequest(request);
    if (apiKey && this.supportsApiKey) {
      await this.authenticateApiKey(request, apiKey);
      return;
    }

    const bearerToken = getBearerTokenFromRequest(request);
    if (bearerToken && this.supportsClerk && looksLikeJwt(bearerToken)) {
      const verified = await this.clerkSessionVerifier.verify(bearerToken);
      const principal = verified.orgId ?? verified.subject;
      request.tenantId = deriveTenantIdFromClerkPrincipal(principal);
      return;
    }

    // A bearer token that contains dots but is not a three-segment JWT is not a Clerk token; when
    // the API key path is enabled it gets one chance to be a (badly transported) API key.
    if (bearerToken && this.supportsApiKey && !looksLikeJwt(bearerToken)) {
      await this.authenticateApiKey(request, bearerToken);
      return;
    }

    throw new UnauthorizedException('auth_required');
  }

  private async authenticateApiKey(request: Request, apiKey: string): Promise<void> {
    const record = await this.apiKeysRepository.verifyApiKey(apiKey);
    if (!record) {
      // Unknown, malformed and revoked keys are deliberately indistinguishable to the caller.
      throw new UnauthorizedException('invalid_api_key');
    }

    request.apiKey = apiKey;
    request.tenantId = record.tenantId;
  }
}
