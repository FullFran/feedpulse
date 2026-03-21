import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { URL } from 'node:url';

/**
 * Manages HTTP/HTTPS agents with keep-alive enabled to reuse TCP/TLS connections
 * across feed fetches. This dramatically reduces connection overhead for repeated
 * requests to the same domains.
 */
export class HttpAgents {
  private readonly httpAgent: HttpAgent;
  private readonly httpsAgent: HttpsAgent;

  constructor(options?: { keepAliveMs?: number; maxSockets?: number }) {
    const { keepAliveMs = 30_000, maxSockets = 50 } = options ?? {};

    this.httpAgent = new HttpAgent({
      keepAlive: true,
      keepAliveMsecs: keepAliveMs,
      maxSockets,
      scheduling: 'fifo',
    });

    this.httpsAgent = new HttpsAgent({
      keepAlive: true,
      keepAliveMsecs: keepAliveMs,
      maxSockets,
      scheduling: 'fifo',
      // Allow self-signed certs in development only
      rejectUnauthorized: process.env['NODE_ENV'] !== 'development',
    });
  }

  /**
   * Returns the appropriate dispatcher (agent) for a given URL.
   * Works with Node.js 18+ fetch() dispatcher option.
   */
  getAgentForUrl(url: string): HttpAgent | HttpsAgent {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? this.httpsAgent : this.httpAgent;
  }

  /** Pre-warm agent cache by ensuring the agent for a URL is ready. No-op for keepAlive agents. */
  warmForUrl(_url: string): void {
    // keepAlive agents are already connection-pooled; nothing to warm
  }

  /** Close all agent connections gracefully. Call on shutdown. */
  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.httpAgent.destroy();
      this.httpsAgent.destroy();
      resolve();
    });
  }
}
