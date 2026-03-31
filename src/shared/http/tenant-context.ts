import { createHash } from 'node:crypto';

import { UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

export const LEGACY_TENANT_ID = 'legacy';

function getApiKeyFromRequest(request: Request): string | null {
  const authorization = request.header('authorization');
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    const value = authorization.slice(7).trim();
    if (value.length > 0) {
      return value;
    }
  }

  const xApiKey = request.header('x-api-key')?.trim();
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

export function deriveTenantIdFromApiKey(apiKey: string): string {
  return `ak_${createHash('sha256').update(apiKey).digest('hex').slice(0, 24)}`;
}

export function resolveTenantIdFromRequest(request: Request): string {
  if (request.tenantId) {
    return request.tenantId;
  }

  if (process.env['NODE_ENV'] === 'test') {
    request.tenantId = LEGACY_TENANT_ID;
    return request.tenantId;
  }

  const apiKey = getApiKeyFromRequest(request);
  if (!apiKey) {
    throw new UnauthorizedException('missing_api_key');
  }

  request.apiKey = apiKey;
  request.tenantId = deriveTenantIdFromApiKey(apiKey);
  return request.tenantId;
}
