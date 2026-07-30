import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { HttpAuthService } from './http-auth.service';

/** Every route below this prefix requires an authenticated tenant. */
export const GUARDED_PATH_PREFIX = '/api/';

/** Routes the dashboard has to reach before it owns any credential. */
export const PUBLIC_API_PATHS: readonly string[] = ['/api/v1/auth/dashboard-config'];

function resolvePath(request: Request): string {
  if (typeof request.path === 'string' && request.path.length > 0) {
    return request.path;
  }

  const url = request.url ?? '';
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

/**
 * Global authentication guard.
 *
 * This used to be a raw Express `app.use()` middleware calling `next(error)`.
 * Express middleware runs outside Nest's exception layer, so rejections were
 * rendered by Express' `finalhandler` as an HTML page that includes the stack
 * trace whenever `NODE_ENV !== 'production'`. As an `APP_GUARD` the same failure
 * flows through `AllExceptionsFilter` and comes back as the JSON error envelope.
 *
 * The path logic mirrors the former middleware exactly: only `/api/` routes are
 * guarded and the dashboard bootstrap endpoint stays public.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly httpAuthService: HttpAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const path = resolvePath(request);

    if (!path.startsWith(GUARDED_PATH_PREFIX) || PUBLIC_API_PATHS.includes(path)) {
      return true;
    }

    await this.httpAuthService.authenticateRequest(request);
    return true;
  }
}
