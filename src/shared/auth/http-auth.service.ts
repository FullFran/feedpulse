import { Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

import { AppConfigService } from '../config/app-config.service';
import {
  deriveTenantIdFromApiKey,
  deriveTenantIdFromClerkPrincipal,
  getApiKeyFromRequest,
  getBearerTokenFromRequest,
} from '../http/tenant-context';

import { ClerkSessionVerifierService } from './clerk-session-verifier.service';

function looksLikeJwt(value: string): boolean {
  return value.split('.').length === 3;
}

@Injectable()
export class HttpAuthService {
  constructor(
    private readonly appConfigService: AppConfigService,
    private readonly clerkSessionVerifier: ClerkSessionVerifierService,
  ) {}

  private get supportsApiKey(): boolean {
    const provider = this.appConfigService.authProvider.toLowerCase();
    return provider === 'api_key' || provider === 'clerk_api_key';
  }

  private get supportsClerk(): boolean {
    const provider = this.appConfigService.authProvider.toLowerCase();
    return provider === 'clerk' || provider === 'clerk_api_key';
  }

  async authenticateRequest(request: Request): Promise<void> {
    if (request.tenantId) {
      return;
    }

    const apiKey = getApiKeyFromRequest(request);
    if (apiKey && this.supportsApiKey) {
      request.apiKey = apiKey;
      request.tenantId = deriveTenantIdFromApiKey(apiKey);
      return;
    }

    const bearerToken = getBearerTokenFromRequest(request);
    if (bearerToken && this.supportsClerk && looksLikeJwt(bearerToken)) {
      const verified = await this.clerkSessionVerifier.verify(bearerToken);
      const principal = verified.orgId ?? verified.subject;
      request.tenantId = deriveTenantIdFromClerkPrincipal(principal);
      return;
    }

    if (bearerToken && this.supportsApiKey && !looksLikeJwt(bearerToken)) {
      request.apiKey = bearerToken;
      request.tenantId = deriveTenantIdFromApiKey(bearerToken);
      return;
    }

    if (process.env['NODE_ENV'] === 'test' && !this.appConfigService.enableAuth) {
      request.tenantId = 'legacy';
      return;
    }

    throw new UnauthorizedException(this.appConfigService.enableAuth ? 'auth_required' : 'missing_api_key');
  }
}
