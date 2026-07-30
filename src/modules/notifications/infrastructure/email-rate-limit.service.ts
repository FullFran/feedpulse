import { Inject, Injectable, Logger } from '@nestjs/common';
import { REDIS_CONNECTION } from '../../../infrastructure/queue/queue.constants';
import { AppConfigService } from '../../../shared/config/app-config.service';

/** Minimal Redis surface needed for the daily email counter. */
interface EmailRateLimitRedisClient {
  get(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<number>;
}

/**
 * The only configuration this service reads.
 *
 * Declared structurally rather than as `AppConfigService` on purpose:
 * `RESEND_DAILY_LIMIT` is added to the env schema by the integrator, and this
 * service must compile and behave sensibly both before and after that lands.
 * When the key is absent, `DEFAULT_RESEND_DAILY_LIMIT` applies.
 */
interface EmailRateLimitConfigPort {
  readonly resendApiKey?: string;
  readonly resendDailyLimit?: number;
}

/** TTL of the daily counter: 25h, so it always outlives the calendar day it tracks. */
const COUNTER_TTL_SECONDS = 25 * 60 * 60;

/**
 * Resend's free tier caps emails at the ACCOUNT level (~100/day), not per
 * tenant, so this is the fallback that keeps one noisy tenant from eating the
 * shared allowance.
 */
export const DEFAULT_RESEND_DAILY_LIMIT = 100;

/** Reason recorded on the alert when the daily quota blocked an email. */
export const EMAIL_QUOTA_EXCEEDED_REASON = 'quota_exceeded';

export interface EmailQuotaDecision {
  /** False only when the tenant is over its daily quota and no email may be sent. */
  allowed: boolean;
  /** Effective daily limit at the moment of the decision. */
  limit: number;
  /** Emails counted against the tenant today, including this reservation when granted. */
  used: number;
  /** True when Redis was unreachable and the decision failed open. */
  degraded: boolean;
}

/**
 * EmailRateLimitService — per-tenant daily email quota, counted in Redis.
 *
 * KEY: `email:daily:{tenantId}:{YYYY-MM-DD}`. The day boundary is UTC, not the
 * operator's local midnight: a tenant in UTC+13 sees the counter reset in the
 * middle of their afternoon. This is deliberate (every worker agrees on the
 * boundary without a tenant timezone lookup) and must stay documented, because
 * "daily" reads as local time to everyone who has not seen this comment.
 *
 * FAIL-OPEN: a Redis outage must never block alert delivery. Every method
 * swallows Redis errors and grants the send. Over-sending during an outage is
 * recoverable; silently dropping alerts is not.
 */
@Injectable()
export class EmailRateLimitService {
  private readonly logger = new Logger(EmailRateLimitService.name);

  constructor(
    @Inject(REDIS_CONNECTION) private readonly redis: EmailRateLimitRedisClient,
    @Inject(AppConfigService) private readonly appConfigService: EmailRateLimitConfigPort,
  ) {}

  /**
   * Atomically claim one email from the tenant's daily allowance.
   *
   * A read-then-increment pair (`canSendEmail` + `incrementCounter`) is not
   * enough: N workers processing N alerts concurrently all read `limit - 1` and
   * all send. The counter is therefore incremented FIRST — `INCR` is atomic —
   * and the increment is given back when the result overshoots the limit. The
   * `DECR` in that path can only ever undo this call's own `INCR`, so it cannot
   * hand a slot to a caller that never reserved one.
   *
   * Call `release` when the send itself fails, so a broken transport does not
   * burn the tenant's allowance for the rest of the day.
   */
  async reserve(tenantId: string): Promise<EmailQuotaDecision> {
    const limit = this.dailyLimit;

    if (limit <= 0) {
      return { allowed: true, limit, used: 0, degraded: false };
    }

    const key = this.buildKey(tenantId);

    try {
      const used = await this.redis.incr(key);

      if (used === 1) {
        // First email of the day for this tenant: the key needs an expiry or it
        // outlives the day it counts.
        await this.redis.expire(key, COUNTER_TTL_SECONDS);
      }

      if (used > limit) {
        await this.giveBack(key);
        return { allowed: false, limit, used: limit, degraded: false };
      }

      return { allowed: true, limit, used, degraded: false };
    } catch (error) {
      this.logger.warn(`Email quota reservation failed for tenant ${tenantId}, failing open: ${describe(error)}`);
      return { allowed: true, limit, used: 0, degraded: true };
    }
  }

  /** Return a reservation to the pool after a failed send. Never throws. */
  async release(tenantId: string): Promise<void> {
    if (this.dailyLimit <= 0) {
      return;
    }

    try {
      await this.giveBack(this.buildKey(tenantId));
    } catch (error) {
      this.logger.warn(`Email quota release failed for tenant ${tenantId}: ${describe(error)}`);
    }
  }

  /** Emails counted against the tenant today, and the limit they count against. */
  async getUsage(tenantId: string): Promise<{ sent: number; limit: number }> {
    const limit = this.dailyLimit;

    try {
      const raw = await this.redis.get(this.buildKey(tenantId));
      const sent = raw === null ? 0 : Number.parseInt(raw, 10);

      return { sent: Number.isFinite(sent) && sent > 0 ? sent : 0, limit };
    } catch (error) {
      this.logger.warn(`Email quota usage lookup failed for tenant ${tenantId}: ${describe(error)}`);
      return { sent: 0, limit };
    }
  }

  /**
   * A daily limit of zero or less disables the quota entirely — the escape
   * hatch for a self-hosted deployment on its own SMTP/Resend account.
   */
  private get dailyLimit(): number {
    const configured = this.appConfigService.resendDailyLimit;

    return typeof configured === 'number' && Number.isFinite(configured) ? configured : DEFAULT_RESEND_DAILY_LIMIT;
  }

  private async giveBack(key: string): Promise<void> {
    const remaining = await this.redis.decr(key);

    if (remaining <= 0) {
      // `DECR` on a key that expired mid-flight recreates it WITHOUT a TTL, and
      // a negative counter would silently grant extra sends tomorrow. Re-arming
      // the expiry keeps the key from leaking either way.
      await this.redis.expire(key, COUNTER_TTL_SECONDS);
    }
  }

  /** UTC day boundary — see the class comment. */
  private buildKey(tenantId: string): string {
    const utcDay = new Date().toISOString().slice(0, 10);

    return `email:daily:${tenantId}:${utcDay}`;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown_redis_failure';
}
