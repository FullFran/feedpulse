import 'reflect-metadata';
import 'dotenv/config';

import type { INestApplication } from '@nestjs/common';
import { writeFile } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { format, resolveConfig } from 'prettier';

/** Where the committed OpenAPI document lives, relative to the repository root. */
const OUTPUT_PATH = join(process.cwd(), 'docs', 'openapi.json');

/**
 * Placeholder connection strings.
 *
 * `env.schema.ts` requires `DATABASE_URL` and `REDIS_URL` to be present, but
 * generating the document never issues a query: `pg.Pool` connects lazily and the
 * Redis client's connection failures are not fatal to bootstrap. Defaulting them
 * keeps `npm run docs:openapi` runnable on a machine with no stack running, which
 * is the whole point of committing the artefact.
 */
const PLACEHOLDER_DATABASE_URL = 'postgres://openapi:openapi@127.0.0.1:1/openapi';
const PLACEHOLDER_REDIS_URL = 'redis://127.0.0.1:1';

// ---------------------------------------------------------------------------
// ORDER IS LOAD-BEARING. These assignments must run BEFORE `AppModule` is
// required, because `ConfigModule.forRoot({ validate })` is evaluated while the
// module decorator is being built — that is, at import time, not at
// `NestFactory.create` time. TypeScript's CommonJS emit keeps top-level
// statements and `require` calls in source order, so putting the environment
// preparation above the import below is what makes it effective. Moving the
// import up makes the script fail with "Invalid environment configuration".
// ---------------------------------------------------------------------------

// Swagger is off by default in production; the dump must not depend on how the
// machine running it happens to be configured.
process.env.ENABLE_SWAGGER = 'true';
process.env.NODE_ENV ??= 'development';
process.env.DATABASE_URL ??= PLACEHOLDER_DATABASE_URL;
process.env.REDIS_URL ??= PLACEHOLDER_REDIS_URL;

import { createApiApplication } from '../../src/main/create-api-app';

/**
 * Regenerates `docs/openapi.json` from the running Nest application.
 *
 * The document is read back over HTTP from `/docs-json` rather than rebuilt with
 * a second `DocumentBuilder`. That is deliberate: a duplicated builder is a
 * second source of truth that drifts silently, and the point of this script is
 * to make drift impossible. Whatever the API actually serves is what lands in
 * the file.
 *
 * The result is committed, so a pull request that changes a route, a DTO or a
 * response envelope shows the contract change in its own diff.
 */
async function run(): Promise<void> {
  let app: INestApplication | undefined;

  try {
    app = await createApiApplication();
    await app.listen(0, '127.0.0.1');

    const address = app.getHttpServer().address() as AddressInfo | string | null;
    if (!address || typeof address === 'string') {
      throw new Error('Could not resolve the ephemeral port the API bound to.');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/docs-json`);
    if (!response.ok) {
      throw new Error(`GET /docs-json answered ${response.status}. Is ENABLE_SWAGGER honoured?`);
    }

    const document: unknown = await response.json();
    // Formatted with the repository's own Prettier configuration rather than a
    // hand-rolled indent, so `npm run docs:openapi` never leaves the tree failing
    // `npm run format:check`.
    const prettierOptions = await resolveConfig(OUTPUT_PATH);
    const formatted = await format(JSON.stringify(document), { ...prettierOptions, filepath: OUTPUT_PATH });
    await writeFile(OUTPUT_PATH, formatted, 'utf8');
    console.log(`OpenAPI document written to ${OUTPUT_PATH}`);
  } finally {
    await app?.close();
  }
}

void run().catch((error: unknown) => {
  console.error(`OpenAPI dump failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
