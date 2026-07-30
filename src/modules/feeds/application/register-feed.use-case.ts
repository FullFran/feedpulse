import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../shared/config/app-config.service';
import { assertSafePublicUrl, resolveAllowPrivateFeedHosts } from '../../../shared/http/url-safety';
import { Feed } from '../domain/feed.entity';
import { FeedsRepository } from '../feeds.repository';

/**
 * Feed rows a single tenant may own before registration is refused.
 *
 * Every feed is a recurring cost the operator pays forever: a scheduler slot, an
 * outbound fetch per poll interval, and the storage of every entry it produces.
 * Without a ceiling one API key can enrol an unbounded number of them.
 */
export const DEFAULT_MAX_FEEDS_PER_TENANT = 500;

/**
 * Structural view of `AppConfigService`.
 *
 * `maxFeedsPerTenant` is optional so the cap works both before and after
 * `MAX_FEEDS_PER_TENANT` is wired into `env.schema.ts` / `configuration.ts` /
 * `app-config.service.ts`; until then the raw environment variable is read
 * directly. `nodeEnv` is required only so TypeScript does not treat this as a
 * weak type and reject a real `AppConfigService`.
 */
export interface FeedQuotaConfigSource {
  readonly nodeEnv: string;
  readonly maxFeedsPerTenant?: number;
}

/** Resolves the per-tenant feed cap. `0` disables the cap entirely. */
export function resolveMaxFeedsPerTenant(source: FeedQuotaConfigSource): number {
  const configured = source.maxFeedsPerTenant;
  if (typeof configured === 'number' && Number.isInteger(configured) && configured >= 0) {
    return configured;
  }

  const raw = process.env.MAX_FEEDS_PER_TENANT;
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return DEFAULT_MAX_FEEDS_PER_TENANT;
}

@Injectable()
export class RegisterFeedUseCase {
  constructor(
    private readonly feedsRepository: FeedsRepository,
    @Inject(AppConfigService) private readonly appConfigService: AppConfigService,
  ) {}

  async execute(input: {
    tenantId: string;
    url: string;
    pollIntervalSeconds?: number;
    status?: 'active' | 'paused' | 'error';
  }): Promise<Feed> {
    // Write-time check. The fetcher validates again at request time (defence in
    // depth): feeds can also be created by the OPML importer, which does not go
    // through this use case, and a stored URL may become unsafe later.
    try {
      assertSafePublicUrl(input.url, { allowPrivateHosts: resolveAllowPrivateFeedHosts(this.appConfigService) });
    } catch {
      throw new BadRequestException('unsafe_feed_url');
    }

    await this.assertQuotaAvailable(input.tenantId);

    return this.feedsRepository.create({
      tenantId: input.tenantId,
      url: input.url,
      pollIntervalSeconds: input.pollIntervalSeconds ?? 1800,
      status: input.status ?? 'active',
    });
  }

  /**
   * Soft quota, deliberately: the count and the insert are two statements, so
   * two concurrent registrations at the boundary can both pass and leave the
   * tenant one row over the cap. Making it exact needs a database-level
   * constraint; overshooting by the number of in-flight requests is an
   * acceptable price for not serialising every feed registration.
   */
  private async assertQuotaAvailable(tenantId: string): Promise<void> {
    const maxFeeds = resolveMaxFeedsPerTenant(this.appConfigService);
    if (maxFeeds <= 0) {
      return;
    }

    // `pageSize: 1` because only `total` is used; the repository counts with a
    // separate `COUNT(*)` and the one returned row is discarded.
    const { total } = await this.feedsRepository.list({ tenantId, page: 1, pageSize: 1 });
    if (total < maxFeeds) {
      return;
    }

    throw new ForbiddenException({
      code: 'feed_limit_reached',
      message: `Feed limit reached for this tenant (${maxFeeds} feeds). Remove feeds or raise MAX_FEEDS_PER_TENANT.`,
    });
  }
}
