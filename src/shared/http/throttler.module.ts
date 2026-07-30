import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Module,
  SetMetadata,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { REDIS_CONNECTION } from '../../infrastructure/queue/queue.constants';
import { AppConfigModule } from '../config/app-config.module';
import { AppConfigService } from '../config/app-config.service';

/**
 * Inbound rate limiting.
 *
 * Everything the API exposes below `/api/` costs the operator something: a feed
 * check enqueues a BullMQ job and an outbound fetch, an OPML import fans out to
 * hundreds of feeds, and `POST /api/v1/alerts/:id/send` spends the operator's
 * shared Resend and Telegram credentials. Before this module a single valid API
 * key could drive all of that without any ceiling.
 *
 * WHY NOT `@nestjs/throttler`: its default storage is a per-process `Map`. This
 * product ships as three runtimes (api/scheduler/worker) and the api runtime is
 * the one meant to scale horizontally, so a process-local counter multiplies the
 * effective limit by the replica count — a decorative limit. The Redis-backed
 * storage adapter for `@nestjs/throttler` is a third-party package; this module
 * instead reuses the `REDIS_CONNECTION` that `QueueModule` already owns, which
 * costs no new dependency and keeps `npm audit` at zero.
 *
 * COUPLING TO REDIS — read before changing `QueueModule`: the counters live in
 * the same Redis instance BullMQ uses. If that connection is ever split per
 * runtime, or swapped for a per-process client, the limits silently become
 * per-replica again. The store degrades to an in-process fallback when the
 * injected connection cannot run Lua (which is what test doubles do), and logs
 * a warning at construction so that never happens unnoticed in production.
 *
 * GUARD ORDER — this guard must run AFTER `AuthGuard`, which is what populates
 * `request.tenantId`. Running before it would key every authenticated request
 * on the source IP and put a whole NAT behind one shared budget. See
 * {@link RateLimitModule} for how that ordering is guaranteed.
 */

/** Metadata key set by {@link RateLimit}. */
export const RATE_LIMIT_POLICY_METADATA = 'feedpulse:rate-limit-policy';

/** Metadata key set by {@link SkipRateLimit}. */
export const RATE_LIMIT_SKIP_METADATA = 'feedpulse:rate-limit-skip';

/** Injection token for the counter store. */
export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');

/** Injection token for the resolved limits. */
export const RATE_LIMIT_OPTIONS = Symbol('RATE_LIMIT_OPTIONS');

/**
 * `default` covers every `/api/` route. `write` is the tighter budget for the
 * endpoints that enqueue work, perform an outbound fetch, or spend a shared
 * notification credential.
 */
export type RateLimitPolicyName = 'default' | 'write';

/** Overrides the policy a handler (or a whole controller) is billed against. */
export const RateLimit = (policy: RateLimitPolicyName) => SetMetadata(RATE_LIMIT_POLICY_METADATA, policy);

/** Exempts a handler (or a whole controller) from inbound rate limiting. */
export const SkipRateLimit = () => SetMetadata(RATE_LIMIT_SKIP_METADATA, true);

export interface RateLimitConsumption {
  /** Hits recorded in the current window, INCLUDING the request being served. */
  readonly totalHits: number;
  /** Milliseconds until the current window rolls over. */
  readonly resetAfterMs: number;
}

export interface RateLimitStore {
  consume(key: string, windowMs: number): Promise<RateLimitConsumption>;
}

export interface RateLimitOptions {
  readonly windowMs: number;
  readonly defaultLimit: number;
  readonly writeLimit: number;
}

/**
 * Structural view of `AppConfigService`.
 *
 * The limit getters are optional on purpose: this module has to work both
 * before and after the typed configuration is wired (`RATE_LIMIT_TTL_SECONDS`,
 * `RATE_LIMIT_MAX_REQUESTS`, `RATE_LIMIT_WRITE_MAX_REQUESTS` in
 * `env.schema.ts` / `configuration.ts` / `app-config.service.ts`). `nodeEnv` is
 * required only so TypeScript does not treat this as a weak type and reject a
 * real `AppConfigService`.
 */
export interface RateLimitConfigSource {
  readonly nodeEnv: string;
  readonly rateLimitTtlSeconds?: number;
  readonly rateLimitMaxRequests?: number;
  readonly rateLimitWriteMaxRequests?: number;
}

/** One minute. Long enough to absorb a dashboard refresh burst. */
export const DEFAULT_RATE_LIMIT_TTL_SECONDS = 60;

/** Requests per window per tenant across all `/api/` routes. */
export const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 300;

/** Requests per window per tenant across the enqueue/outbound endpoints. */
export const DEFAULT_RATE_LIMIT_WRITE_MAX_REQUESTS = 30;

const KEY_PREFIX = 'feedpulse:ratelimit';

/**
 * Monitoring endpoints are scraped on a fixed interval and must never 429: a
 * throttled `/ready` reads as a dead container to an orchestrator. They all sit
 * outside `/api/` today, so this set is a belt-and-braces guard for the day one
 * of them moves under the prefix.
 */
const UNLIMITED_PATHS: ReadonlySet<string> = new Set(['/health', '/ready', '/live', '/metrics']);

const RATE_LIMITED_PATH_PREFIX = '/api/';

interface WriteRouteRule {
  readonly method: string;
  readonly pattern: RegExp;
}

/**
 * Routes billed against the `write` budget.
 *
 * These are matched by path rather than declared with `@RateLimit('write')` so
 * that the policy is auditable in one place and cannot be lost when a
 * controller is refactored. Handlers may still opt in explicitly with the
 * decorator; handler metadata wins over this table.
 */
const WRITE_ROUTE_RULES: readonly WriteRouteRule[] = [
  // Enqueues a fetch job outside the scheduler's pacing.
  { method: 'POST', pattern: /^\/api\/v1\/feeds\/[^/]+\/check-now$/ },
  // Authenticated outbound-fetch primitive: an SSRF probe if the URL guard ever
  // has a hole, so it gets the tight budget even though it writes nothing.
  { method: 'POST', pattern: /^\/api\/v1\/feeds\/validate$/ },
  // Fans out to one feed row (and eventually one fetch) per OPML outline.
  { method: 'POST', pattern: /^\/api\/v1\/opml\/imports$/ },
  { method: 'POST', pattern: /^\/api\/v1\/opml\/imports\/[^/]+\/confirm$/ },
  // Spends the operator's shared Resend / Telegram credentials.
  { method: 'POST', pattern: /^\/api\/v1\/alerts\/[^/]+\/send$/ },
];

function readIntEnv(name: string, minimum: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    return undefined;
  }

  return parsed;
}

function resolveLimit(configured: number | undefined, envName: string, fallback: number): number {
  if (typeof configured === 'number' && Number.isInteger(configured) && configured >= 0) {
    return configured;
  }

  return readIntEnv(envName, 0) ?? fallback;
}

/**
 * Reads the limits from the typed configuration when it exposes them, and from
 * the raw environment otherwise. A limit of `0` disables that bucket.
 */
export function resolveRateLimitOptions(source: RateLimitConfigSource): RateLimitOptions {
  const ttlSeconds =
    typeof source.rateLimitTtlSeconds === 'number' && source.rateLimitTtlSeconds > 0
      ? source.rateLimitTtlSeconds
      : (readIntEnv('RATE_LIMIT_TTL_SECONDS', 1) ?? DEFAULT_RATE_LIMIT_TTL_SECONDS);

  return {
    windowMs: ttlSeconds * 1000,
    defaultLimit: resolveLimit(source.rateLimitMaxRequests, 'RATE_LIMIT_MAX_REQUESTS', DEFAULT_RATE_LIMIT_MAX_REQUESTS),
    writeLimit: resolveLimit(
      source.rateLimitWriteMaxRequests,
      'RATE_LIMIT_WRITE_MAX_REQUESTS',
      DEFAULT_RATE_LIMIT_WRITE_MAX_REQUESTS,
    ),
  };
}

/**
 * Fixed-window counter, incremented and expired in one round trip so two
 * concurrent requests cannot both see "first hit of the window" and leave the
 * key without a TTL (which would freeze the tenant out permanently).
 */
const CONSUME_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return {hits, redis.call('PTTL', KEYS[1])}
`;

/** The single Redis command this module needs. */
export interface RateLimitRedisClient {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

function toPositiveNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly client: RateLimitRedisClient) {}

  async consume(key: string, windowMs: number): Promise<RateLimitConsumption> {
    const reply: unknown = await this.client.eval(CONSUME_SCRIPT, 1, key, windowMs);

    if (!Array.isArray(reply)) {
      throw new Error('rate_limit_store_unexpected_reply');
    }

    const values: unknown[] = reply;
    const totalHits = toPositiveNumber(values[0]);
    if (totalHits === null) {
      throw new Error('rate_limit_store_unexpected_reply');
    }

    // PTTL answers -1 (no expiry) or -2 (missing) in races; fall back to a full
    // window rather than reporting a negative reset to the caller.
    return { totalHits, resetAfterMs: toPositiveNumber(values[1]) ?? windowMs };
  }
}

/**
 * Process-local fallback. Correct for a single replica and for tests; wrong the
 * moment the API is scaled out, which is why {@link createRateLimitStore} warns
 * when it has to pick this one.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, { hits: number; expiresAtMs: number }>();

  // Not `async`: the whole operation is synchronous, and the interface only
  // returns a promise because the Redis implementation has to.
  consume(key: string, windowMs: number): Promise<RateLimitConsumption> {
    const now = Date.now();
    const existing = this.windows.get(key);

    if (existing && existing.expiresAtMs > now) {
      existing.hits += 1;
      return Promise.resolve({ totalHits: existing.hits, resetAfterMs: existing.expiresAtMs - now });
    }

    this.evictExpired(now);
    this.windows.set(key, { hits: 1, expiresAtMs: now + windowMs });
    return Promise.resolve({ totalHits: 1, resetAfterMs: windowMs });
  }

  /** Test seam: drops every window. */
  reset(): void {
    this.windows.clear();
  }

  /**
   * Without this the map grows once per distinct key forever, which for the
   * IP-keyed public routes is an unbounded memory leak.
   */
  private evictExpired(now: number): void {
    for (const [key, window] of this.windows) {
      if (window.expiresAtMs <= now) {
        this.windows.delete(key);
      }
    }
  }
}

function asRedisClient(connection: unknown): RateLimitRedisClient | null {
  if (typeof connection !== 'object' || connection === null) {
    return null;
  }

  const candidate = connection as { eval?: unknown };
  return typeof candidate.eval === 'function' ? (connection as RateLimitRedisClient) : null;
}

export function createRateLimitStore(
  connection: unknown,
  logger: Logger = new Logger('RateLimitStore'),
): RateLimitStore {
  const client = asRedisClient(connection);
  if (client) {
    return new RedisRateLimitStore(client);
  }

  logger.warn(
    'Redis connection cannot evaluate Lua; inbound rate limiting fell back to a per-process counter. ' +
      'With more than one API replica the effective limit is multiplied by the replica count.',
  );
  return new MemoryRateLimitStore();
}

function resolvePath(request: Request): string {
  const raw = typeof request.path === 'string' && request.path.length > 0 ? request.path : (request.url ?? '');
  const queryStart = raw.indexOf('?');
  const path = queryStart === -1 ? raw : raw.slice(0, queryStart);

  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * The budget owner. Authenticated traffic is billed per tenant so one noisy
 * tenant cannot exhaust another's allowance; the handful of unauthenticated
 * `/api/` routes fall back to the peer address.
 *
 * `request.ip` only reflects `X-Forwarded-For` when Express' `trust proxy` is
 * enabled, which it is not: behind a proxy every request currently shares the
 * proxy's address on the unauthenticated bucket. Enabling `trust proxy` without
 * a trusted hop list would instead let any client forge its own bucket.
 */
function resolveScope(request: Request): string {
  if (request.tenantId) {
    return `tenant:${request.tenantId}`;
  }

  return `ip:${request.ip ?? request.socket?.remoteAddress ?? 'unknown'}`;
}

function resolvePolicyFromRoute(method: string, path: string): RateLimitPolicyName {
  const upperMethod = method.toUpperCase();
  const matched = WRITE_ROUTE_RULES.some((rule) => rule.method === upperMethod && rule.pattern.test(path));
  return matched ? 'write' : 'default';
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error);
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
    @Inject(RATE_LIMIT_OPTIONS) private readonly options: RateLimitOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const path = resolvePath(request);

    if (!path.startsWith(RATE_LIMITED_PATH_PREFIX) || UNLIMITED_PATHS.has(path)) {
      return true;
    }

    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(RATE_LIMIT_SKIP_METADATA, targets) === true) {
      return true;
    }

    const policy =
      this.reflector.getAllAndOverride<RateLimitPolicyName>(RATE_LIMIT_POLICY_METADATA, targets) ??
      resolvePolicyFromRoute(request.method, path);
    const limit = policy === 'write' ? this.options.writeLimit : this.options.defaultLimit;

    if (limit <= 0) {
      return true;
    }

    const key = `${KEY_PREFIX}:${policy}:${resolveScope(request)}`;

    let consumption: RateLimitConsumption;
    try {
      consumption = await this.store.consume(key, this.options.windowMs);
    } catch (error: unknown) {
      // Fail open. A Redis blip must degrade the ceiling, not the API: taking
      // every request down would turn a cache outage into a full outage.
      this.logger.warn(`Rate limit store unavailable, allowing request: ${describeError(error)}`);
      return true;
    }

    const response = context.switchToHttp().getResponse<Response>();
    const resetSeconds = Math.max(1, Math.ceil(consumption.resetAfterMs / 1000));

    response.setHeader('X-RateLimit-Limit', String(limit));
    response.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - consumption.totalHits)));
    response.setHeader('X-RateLimit-Reset', String(resetSeconds));

    if (consumption.totalHits > limit) {
      response.setHeader('Retry-After', String(resetSeconds));

      // Object payload (rather than `new HttpException('rate_limit_exceeded')`)
      // so the envelope carries a stable `code` AND an operator-readable
      // message, instead of repeating the code twice.
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'rate_limit_exceeded',
          message: `Rate limit exceeded for the ${policy} budget (${limit} requests per ${Math.round(
            this.options.windowMs / 1000,
          )}s). Retry in ${resetSeconds}s.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}

/**
 * Provides the guard, its collaborators, and the global registration.
 *
 * WIRING: add `RateLimitModule` to `AppModule`'s `imports`. Do NOT also add an
 * `APP_GUARD` entry to `AppModule`'s `providers` — that would register a second
 * instance and charge every request twice.
 *
 * The `APP_GUARD` binding lives here rather than in `AppModule` because Nest
 * registers global enhancers in module-scan order: the host module's own
 * providers are collected before those of the modules it imports, so binding it
 * from an imported module is what guarantees `AuthGuard` (declared directly in
 * `AppModule`) runs first and `request.tenantId` is populated. Moving this
 * binding into `AppModule`'s provider array puts the two guards in literal
 * array order instead, which is easy to get wrong in a merge.
 */
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: RATE_LIMIT_OPTIONS,
      inject: [AppConfigService],
      useFactory: (configService: AppConfigService): RateLimitOptions => resolveRateLimitOptions(configService),
    },
    {
      provide: RATE_LIMIT_STORE,
      inject: [REDIS_CONNECTION],
      useFactory: (connection: unknown): RateLimitStore => createRateLimitStore(connection),
    },
    RateLimitGuard,
    { provide: APP_GUARD, useExisting: RateLimitGuard },
  ],
  exports: [RateLimitGuard, RATE_LIMIT_STORE, RATE_LIMIT_OPTIONS],
})
export class RateLimitModule {}
