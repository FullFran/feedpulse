import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Pool } from 'pg';

export async function applyMigrations(pool: Pool, migrationsDir = join(process.cwd(), 'db', 'migrations')): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
  const applied: string[] = [];

  for (const file of files) {
    const existing = await pool.query<{ version: string }>('SELECT version FROM schema_migrations WHERE version = $1', [file]);
    if (existing.rowCount) {
      continue;
    }

    const sql = await import('node:fs/promises').then((fs) => fs.readFile(join(migrationsDir, file), 'utf8'));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return applied;
}
