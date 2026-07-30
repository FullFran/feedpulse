import { Logger } from '@nestjs/common';
import {
  DEFAULT_RESEND_DAILY_LIMIT,
  EmailRateLimitService,
} from '../src/modules/notifications/infrastructure/email-rate-limit.service';
import { expectDefined } from './support/expect-defined';

/**
 * Per-tenant daily email quota.
 *
 * Two properties carry the whole design and both are tested here rather than
 * assumed:
 *
 *  1. RESERVATION IS ATOMIC. The obvious implementation — read the counter,
 *     compare it to the limit, then increment — lets N concurrent workers all
 *     read `limit - 1` and all send, which is exactly the account-level overrun
 *     the quota exists to prevent. Only `INCR`-first is safe.
 *  2. IT FAILS OPEN. Redis is a cache, not the source of truth for alerts. A
 *     cache outage that blocked delivery would turn a degraded dependency into
 *     lost alerts.
 */

const TENANT = 'tenant-x';
const KEY_PATTERN = /^email:daily:tenant-x:\d{4}-\d{2}-\d{2}$/;
const TTL_25H_SECONDS = 25 * 60 * 60;

/** In-memory Redis with real INCR/DECR/EXPIRE semantics, including key expiry. */
class FakeRedisCounter {
  readonly counters = new Map<string, number>();
  readonly ttls = new Map<string, number>();
  readonly incrCalls: string[] = [];

  async get(key: string): Promise<string | null> {
    const value = this.counters.get(key);

    return value === undefined ? null : String(value);
  }

  async incr(key: string): Promise<number> {
    this.incrCalls.push(key);
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);

    return next;
  }

  async decr(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) - 1;
    this.counters.set(key, next);

    return next;
  }

  async expire(key: string, ttlSeconds: number): Promise<number> {
    this.ttls.set(key, ttlSeconds);

    return 1;
  }
}

function makeService(options: { limit?: number; redis?: Partial<FakeRedisCounter> } = {}) {
  const redis = new FakeRedisCounter();
  Object.assign(redis, options.redis ?? {});
  // No cast: the service declares the minimal Redis and config surfaces it
  // needs, so these plain doubles satisfy them structurally.
  const appConfigService = { resendDailyLimit: options.limit };
  const service = new EmailRateLimitService(redis, appConfigService);

  return { service, redis };
}

describe('EmailRateLimitService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('reserve', () => {
    it('grants a slot and counts it against the tenant', async () => {
      const { service } = makeService({ limit: 3 });

      await expect(service.reserve(TENANT)).resolves.toEqual({
        allowed: true,
        limit: 3,
        used: 1,
        degraded: false,
      });
    });

    it('writes the counter under a per-tenant UTC day key', async () => {
      const { service, redis } = makeService({ limit: 3 });

      await service.reserve(TENANT);

      expect(redis.incrCalls[0]).toMatch(KEY_PATTERN);
    });

    it('arms a 25h expiry on the first email of the day only', async () => {
      const { service, redis } = makeService({ limit: 3 });

      await service.reserve(TENANT);
      const key = expectDefined(redis.incrCalls[0]);
      expect(redis.ttls.get(key)).toBe(TTL_25H_SECONDS);

      redis.ttls.delete(key);
      await service.reserve(TENANT);

      // Re-arming the TTL on every send would push the expiry forward forever
      // and the counter would never reset.
      expect(redis.ttls.has(key)).toBe(false);
    });

    it('refuses the send once the limit is reached', async () => {
      const { service } = makeService({ limit: 2 });

      await service.reserve(TENANT);
      await service.reserve(TENANT);

      await expect(service.reserve(TENANT)).resolves.toEqual({
        allowed: false,
        limit: 2,
        used: 2,
        degraded: false,
      });
    });

    it('gives the increment back when it refuses, so the counter never drifts above the limit', async () => {
      const { service, redis } = makeService({ limit: 1 });

      await service.reserve(TENANT);
      await service.reserve(TENANT);
      await service.reserve(TENANT);

      const key = expectDefined(redis.incrCalls[0]);
      expect(redis.counters.get(key)).toBe(1);
    });

    it('grants exactly `limit` slots under concurrent reservations', async () => {
      // The read-then-increment implementation this replaced granted all 20.
      const { service } = makeService({ limit: 5 });

      const decisions = await Promise.all(Array.from({ length: 20 }, () => service.reserve(TENANT)));

      expect(decisions.filter((decision) => decision.allowed)).toHaveLength(5);
      expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(15);
    });

    it('applies the Resend free-tier default when no limit is configured', async () => {
      const { service } = makeService();

      const decision = await service.reserve(TENANT);

      expect(decision.limit).toBe(DEFAULT_RESEND_DAILY_LIMIT);
      expect(decision.allowed).toBe(true);
    });

    it('disables the quota entirely when the configured limit is zero', async () => {
      const { service, redis } = makeService({ limit: 0 });

      const decision = await service.reserve(TENANT);

      expect(decision).toEqual({ allowed: true, limit: 0, used: 0, degraded: false });
      // A disabled quota must not even talk to Redis.
      expect(redis.incrCalls).toHaveLength(0);
    });

    it('fails open and flags the decision as degraded when Redis is down', async () => {
      const { service } = makeService({
        limit: 1,
        redis: { incr: jest.fn().mockRejectedValue(new Error('redis down')) },
      });

      await expect(service.reserve(TENANT)).resolves.toEqual({
        allowed: true,
        limit: 1,
        used: 0,
        degraded: true,
      });
    });

    it('counts each tenant separately', async () => {
      const { service } = makeService({ limit: 1 });

      await service.reserve('tenant-a');

      await expect(service.reserve('tenant-b')).resolves.toEqual(expect.objectContaining({ allowed: true, used: 1 }));
    });

    it('rolls the counter over at UTC midnight', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-03-20T23:59:59.000Z'));
      const { service, redis } = makeService({ limit: 1 });

      await service.reserve(TENANT);
      await expect(service.reserve(TENANT)).resolves.toEqual(expect.objectContaining({ allowed: false }));

      // 00:00 UTC, not 00:00 local: every worker has to agree on the boundary
      // without looking up a tenant timezone.
      jest.setSystemTime(new Date('2026-03-21T00:00:01.000Z'));

      await expect(service.reserve(TENANT)).resolves.toEqual(expect.objectContaining({ allowed: true, used: 1 }));
      expect([...redis.counters.keys()]).toEqual([
        'email:daily:tenant-x:2026-03-20',
        'email:daily:tenant-x:2026-03-21',
      ]);

      jest.useRealTimers();
    });
  });

  describe('release', () => {
    it('returns a reserved slot to the pool', async () => {
      const { service } = makeService({ limit: 1 });

      await service.reserve(TENANT);
      await service.release(TENANT);

      await expect(service.reserve(TENANT)).resolves.toEqual(expect.objectContaining({ allowed: true }));
    });

    it('re-arms the expiry when the counter drops to zero, so the key cannot leak without a TTL', async () => {
      const { service, redis } = makeService({ limit: 1 });

      await service.reserve(TENANT);
      const key = expectDefined(redis.incrCalls[0]);
      redis.ttls.delete(key);

      await service.release(TENANT);

      expect(redis.ttls.get(key)).toBe(TTL_25H_SECONDS);
    });

    it('never throws when Redis is down', async () => {
      const { service } = makeService({
        limit: 1,
        redis: { decr: jest.fn().mockRejectedValue(new Error('redis down')) },
      });

      await expect(service.release(TENANT)).resolves.toBeUndefined();
    });

    it('does nothing when the quota is disabled', async () => {
      const decr = jest.fn();
      const { service } = makeService({ limit: 0, redis: { decr } });

      await service.release(TENANT);

      expect(decr).not.toHaveBeenCalled();
    });
  });

  describe('getUsage', () => {
    it('reports what the tenant has spent today and against which limit', async () => {
      const { service } = makeService({ limit: 4 });

      await service.reserve(TENANT);
      await service.reserve(TENANT);

      await expect(service.getUsage(TENANT)).resolves.toEqual({ sent: 2, limit: 4 });
    });

    it('reports zero for a tenant that has not sent anything today', async () => {
      const { service } = makeService({ limit: 4 });

      await expect(service.getUsage(TENANT)).resolves.toEqual({ sent: 0, limit: 4 });
    });

    it('reports zero rather than throwing when Redis is down', async () => {
      const { service } = makeService({
        limit: 4,
        redis: { get: jest.fn().mockRejectedValue(new Error('redis down')) },
      });

      await expect(service.getUsage(TENANT)).resolves.toEqual({ sent: 0, limit: 4 });
    });
  });
});
