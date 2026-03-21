import { Injectable, ServiceUnavailableException } from '@nestjs/common';

import { DatabaseService } from './database.service';

@Injectable()
export class ReadinessService {
  constructor(private readonly databaseService: DatabaseService) {}

  async assertSchemaReady(): Promise<void> {
    const result = await this.databaseService.query<{ exists: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'feeds'
        ) AS exists
      `,
    );

    if (!result.rows[0]?.exists) {
      throw new ServiceUnavailableException('Persistence readiness error: base schema is not applied');
    }
  }
}
