import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { createHash } from 'node:crypto';

/**
 * Tenant assigned to every request while `ENABLE_AUTH=false` (single-tenant development mode).
 * It is also the historical tenant of every row created before multi-tenancy landed.
 */
export const LEGACY_TENANT_ID = 'legacy';

export function getBearerTokenFromRequest(request: Request): string | null {
  const authorization = request.header('authorization');
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    const value = authorization.slice(7).trim();
    if (value.length > 0) {
      return value;
    }
  }

  return null;
}

/**
 * Deliberate routing decision: any bearer token WITHOUT a dot is treated as an API key.
 * A well-formed JWT always contains dots, so this only misroutes a malformed, dot-free token —
 * which would fail session verification anyway. The behaviour is pinned in
 * test/tenant-context.spec.ts so it stays a decision rather than an accident.
 */
export function getApiKeyFromRequest(request: Request): string | null {
  const bearer = getBearerTokenFromRequest(request);
  if (bearer && !bearer.includes('.')) {
    return bearer;
  }

  const xApiKey = request.header('x-api-key')?.trim();
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * STORAGE FORMAT — NOT A CACHE.
 *
 * Every row in `feeds`, `rules`, `entries`, `alerts` and `tenant_settings` is keyed by the string
 * produced here. Changing the `ak_` prefix, the hash algorithm, or the 24-character slice silently
 * orphans every existing row of the affected tenant. Golden values are committed as literals in
 * test/tenant-context.spec.ts precisely so such a change cannot pass CI.
 *
 * Authenticated API-key requests no longer use this: they resolve their tenant from the `api_keys`
 * table (see ApiKeysRepository). It is retained for the documented development fallback and for
 * operator tooling that needs to reproduce a historical tenant id.
 */
export function deriveTenantIdFromApiKey(apiKey: string): string {
  return `ak_${createHash('sha256').update(apiKey).digest('hex').slice(0, 24)}`;
}

/**
 * STORAGE FORMAT — NOT A CACHE. Same immutability contract as {@link deriveTenantIdFromApiKey}.
 * This is the live mapping for the Clerk principal path: the tenant is derived from the Clerk
 * organization id, or from the user id when the session carries no organization.
 */
export function deriveTenantIdFromClerkPrincipal(principal: string): string {
  return `ck_${createHash('sha256').update(principal).digest('hex').slice(0, 24)}`;
}

/**
 * Reads the tenant that HttpAuthService already attached to the request.
 *
 * HttpAuthService is the single authentication point: it runs as middleware for every `/api/`
 * route (see create-api-app.ts). This function never authenticates by itself — deriving a tenant
 * from an unverified credential here is exactly the bypass this module used to contain.
 */
export function resolveTenantIdFromRequest(request: Request): string {
  if (request.tenantId) {
    return request.tenantId;
  }

  throw new UnauthorizedException('missing_tenant_context');
}
