import 'reflect-metadata';
import 'dotenv/config';

import { Pool } from 'pg';

import { applyMigrations } from '../infrastructure/persistence/migrations';
import { validateEnv } from '../shared/config/env.schema';

async function run(): Promise<void> {
  const env = validateEnv(process.env);
  const pool = new Pool({ connectionString: env.DATABASE_URL });

  try {
    const applied = await applyMigrations(pool);
    const summary = applied.length ? applied.join(', ') : 'no new migrations';
    console.log(`Migrations applied: ${summary}`);
  } finally {
    await pool.end();
  }
}

void run();
