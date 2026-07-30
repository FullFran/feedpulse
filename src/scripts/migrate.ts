import 'reflect-metadata';
import 'dotenv/config';

import { Pool } from 'pg';
import { applyMigrations } from '../infrastructure/persistence/migrations';
import { seedBootstrapApiKey } from '../modules/auth/api-keys.repository';
import { validateEnv } from '../shared/config/env.schema';

/**
 * Sole entry point for schema migrations. Migrations are never applied at app
 * boot: run `npm run migrate` explicitly before starting the API or workers.
 */
async function run(): Promise<void> {
  const env = validateEnv(process.env);
  const pool = new Pool({ connectionString: env.DATABASE_URL });

  try {
    const applied = await applyMigrations(pool);
    const summary = applied.length ? applied.join(', ') : 'no new migrations';
    console.log(`Migrations applied: ${summary}`);

    // Idempotent: re-running with the same key is a no-op. Without it a fresh
    // deployment has no credential at all and every /api/ call answers 401.
    if (env.BOOTSTRAP_API_KEY) {
      const seeded = await seedBootstrapApiKey(pool, {
        plaintextKey: env.BOOTSTRAP_API_KEY,
        tenantId: env.BOOTSTRAP_API_KEY_TENANT_ID,
        label: 'bootstrap',
      });
      console.log(
        seeded
          ? `Bootstrap API key seeded for tenant ${env.BOOTSTRAP_API_KEY_TENANT_ID}.`
          : 'Bootstrap API key already present.',
      );
    }
  } finally {
    await pool.end();
  }
}

void run().catch((error: unknown) => {
  console.error(`Migration run failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
