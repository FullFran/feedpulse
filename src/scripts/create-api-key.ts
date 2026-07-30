import 'reflect-metadata';
import 'dotenv/config';

import { Pool } from 'pg';
import { DatabaseService } from '../infrastructure/persistence/database.service';
import { ApiKeysRepository } from '../modules/auth/api-keys.repository';
import { validateEnv } from '../shared/config/env.schema';

interface CliOptions {
  tenantId: string;
  label: string | null;
}

const USAGE = 'Usage: npm run apikey:create -- --tenant <tenant-id> [--label <label>]';

export function parseCliArgs(argv: string[]): CliOptions {
  let tenantId: string | null = null;
  let label: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    // `index` is bounded by `argv.length`, so this only guards the compiler's
    // view of an indexed read.
    if (arg === undefined) {
      continue;
    }

    if (arg === '--tenant' || arg === '-t') {
      tenantId = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === '--label' || arg === '-l') {
      label = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg.startsWith('--tenant=')) {
      tenantId = arg.slice('--tenant='.length);
      continue;
    }

    if (arg.startsWith('--label=')) {
      label = arg.slice('--label='.length);
      continue;
    }

    throw new Error(`Unrecognized argument "${arg}". ${USAGE}`);
  }

  if (!tenantId || tenantId.trim().length === 0 || tenantId.startsWith('-')) {
    throw new Error(`Missing required --tenant argument. ${USAGE}`);
  }

  return { tenantId: tenantId.trim(), label: label && label.trim().length > 0 ? label.trim() : null };
}

async function run(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const env = validateEnv(process.env);
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const repository = new ApiKeysRepository(new DatabaseService(pool));

  try {
    const created = await repository.create({ tenantId: options.tenantId, label: options.label });

    console.log('API key created. Store it now — it cannot be recovered.');
    console.log(`  id:        ${created.record.id}`);
    console.log(`  tenant:    ${created.record.tenantId}`);
    console.log(`  label:     ${created.record.label ?? '(none)'}`);
    console.log(`  prefix:    ${created.record.prefix}`);
    console.log(`  key:       ${created.plaintextKey}`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
