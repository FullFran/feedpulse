import { Injectable } from '@nestjs/common';
import { URL } from 'node:url';

import { MetricsService } from '../../observability/metrics.service';

export interface DomainRateLimiterOptions {
  /** Maximum requests per second allowed per domain. Default: 2 */
  requestsPerSecond?: number;
  /** Maximum backoff time in milliseconds. Default: 60000 (1 minute) */
  maxBackoffMs?: number;
  /** Base delay for exponential backoff in milliseconds. Default: 1000 */
  baseBackoffMs?: number;
}

/**
 * Per-domain rate limiter with exponential backoff and Retry-After header support.
 * Prevents hammering individual feed servers while respecting HTTP 429 Retry-After headers.
 */
@Injectable()
export class DomainRateLimiter {
  private readonly requestsPerSecond: number;
  private readonly maxBackoffMs: number;
  private readonly baseBackoffMs: number;

  /** Tracks last request timestamp per domain */
  private readonly lastRequestAt = new Map<string, number>();

  /** Tracks current backoff deadline per domain */
  private readonly backoffUntil = new Map<string, number>();

  private readonly metricsService: MetricsService | null;

  constructor(metricsService: MetricsService, options: DomainRateLimiterOptions = {}) {
    this.metricsService = metricsService;
    this.requestsPerSecond = options.requestsPerSecond ?? 2;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.baseBackoffMs = options.baseBackoffMs ?? 1_000;
  }

  /**
   * Extract the base domain from a URL for consistent keying.
   */
  private getDomainKey(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.hostname;
    } catch {
      // Fallback: use the full URL if parsing fails
      return url;
    }
  }

  /**
   * Check if a domain is currently in backoff (rate limited).
   */
  isBackingOff(url: string): boolean {
    const domain = this.getDomainKey(url);
    const until = this.backoffUntil.get(domain) ?? 0;
    return Date.now() < until;
  }

  /**
   * Get remaining backoff time in milliseconds, 0 if not backing off.
   */
  getBackoffRemainingMs(url: string): number {
    const domain = this.getDomainKey(url);
    const until = this.backoffUntil.get(domain) ?? 0;
    return Math.max(0, until - Date.now());
  }

  /**
   * Apply rate limiting backoff based on Retry-After header or exponential backoff.
   * Records metrics for backoff events.
   * @param url The URL that triggered the rate limit
   * @param retryAfterHeader Retry-After header value (seconds or HTTP date), or null
   * @param isRetry Whether this is a retry attempt (enables exponential backoff)
   */
  applyBackoff(url: string, retryAfterHeader: string | null, isRetry: boolean): void {
    const domain = this.getDomainKey(url);
    let backoffMs = 0;

    if (retryAfterHeader !== null) {
      // Parse Retry-After header: could be seconds or HTTP-date
      const seconds = Number.parseInt(retryAfterHeader, 10);
      if (!Number.isNaN(seconds)) {
        // Retry-After is in seconds
        backoffMs = seconds * 1000;
      } else {
        // HTTP-date format: try to parse and convert to ms
        const retryDate = new Date(retryAfterHeader).getTime();
        if (!Number.isNaN(retryDate)) {
          backoffMs = Math.max(0, retryDate - Date.now());
        }
      }
    }

    // If no Retry-After or it resulted in 0, use exponential backoff for retries
    if (backoffMs === 0 && isRetry) {
      const currentBackoff = this.backoffUntil.get(domain) ?? Date.now();
      const previousBackoffMs = Math.max(0, currentBackoff - Date.now());
      const newBackoffMs = Math.min(
        this.maxBackoffMs,
        Math.max(this.baseBackoffMs, previousBackoffMs * 2),
      );
      backoffMs = newBackoffMs;
    }

    if (backoffMs > 0) {
      this.backoffUntil.set(domain, Date.now() + backoffMs);
      // Record backoff metric if metrics service is available
      this.metricsService?.incrementRateLimitBackoff();
    }
  }

  /**
   * Clear backoff for a domain (e.g., after successful request).
   */
  clearBackoff(url: string): void {
    const domain = this.getDomainKey(url);
    this.backoffUntil.delete(domain);
  }

  /**
   * Wait for any applicable rate limiting before making a request.
   * Returns the number of ms waited (0 if no wait was needed).
   */
  async waitForSlot(url: string): Promise<number> {
    const domain = this.getDomainKey(url);

    // First, wait out any backoff
    const backoffRemaining = this.getBackoffRemainingMs(url);
    if (backoffRemaining > 0) {
      await this.sleep(backoffRemaining);
    }

    // Then, enforce per-domain rate limiting
    const lastRequest = this.lastRequestAt.get(domain) ?? 0;
    const minIntervalMs = 1000 / this.requestsPerSecond;
    const elapsed = Date.now() - lastRequest;

    if (elapsed < minIntervalMs) {
      await this.sleep(minIntervalMs - elapsed);
    }

    // Record this request
    this.lastRequestAt.set(domain, Date.now());
    return Math.max(0, minIntervalMs - elapsed) + backoffRemaining;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Parse Retry-After header value.
   * @returns Seconds as number, or null if unparseable
   */
  static parseRetryAfter(header: string | null): string | null {
    if (!header) return null;
    const trimmed = header.trim().toLowerCase();
    if (/^\d+$/.test(trimmed)) {
      return trimmed; // Return raw seconds string for processing
    }
    // HTTP-date format - return as-is for date parsing
    if (trimmed.includes(',') || trimmed.includes('gmt') || trimmed.includes('utc')) {
      return header.trim(); // Return original format
    }
    return null;
  }
}
