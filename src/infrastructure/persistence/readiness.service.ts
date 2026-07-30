import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from './database.service';

@Injectable()
export class ReadinessService {
  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * Resolves `feeds` through the connection's `search_path` instead of pinning the
   * lookup to the `public` schema. Every repository in this codebase addresses its
   * tables unqualified, so readiness must answer the same question those queries
   * ask: "can this connection see the base schema?". Hardcoding `public` reports
   * ready when the app is pointed at a different schema that happens to be empty,
   * and not-ready when a healthy deployment runs outside `public`.
   */
  async assertSchemaReady(): Promise<void> {
    const result = await this.databaseService.query<{ exists: boolean }>(
      `SELECT to_regclass('feeds') IS NOT NULL AS exists`,
    );

    if (!result.rows[0]?.exists) {
      throw new ServiceUnavailableException('Persistence readiness error: base schema is not applied');
    }
  }
}
