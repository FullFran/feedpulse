process.env.NODE_ENV = 'test';
process.env.PORT = '3002';
process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/rss_monitor_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.LOG_LEVEL = 'error';
process.env.OPML_UPLOAD_MAX_BYTES = '2097152';
process.env.OPML_INITIAL_JITTER_MAX_SECONDS = '1';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { newDb } from 'pg-mem';

import { AppModule } from '../src/app.module';
import { DATABASE_POOL } from '../src/infrastructure/persistence/database.constants';
import { AlertDeliveryQueue } from '../src/infrastructure/queue/alert-delivery.queue';
import { FetchFeedQueue } from '../src/infrastructure/queue/fetch-feed.queue';
import { OpmlApplyImportQueue } from '../src/infrastructure/queue/opml-apply-import.queue';
import { OpmlParsePreviewQueue } from '../src/infrastructure/queue/opml-parse-preview.queue';
import {
  ALERT_DELIVERY_QUEUE_TOKEN,
  AlertDeliveryJobData,
  FETCH_FEED_QUEUE_TOKEN,
  FetchFeedJobData,
  OPML_APPLY_IMPORT_QUEUE_TOKEN,
  OPML_PARSE_PREVIEW_QUEUE_TOKEN,
  OpmlApplyImportJobData,
  OpmlParsePreviewJobData,
  REDIS_CONNECTION,
} from '../src/infrastructure/queue/queue.constants';
import { ConfirmOpmlImportUseCase } from '../src/modules/opml-imports/application/confirm-opml-import.use-case';
import { CreateOpmlImportUseCase } from '../src/modules/opml-imports/application/create-opml-import.use-case';
import { ProcessOpmlApplyJobUseCase } from '../src/modules/opml-imports/application/process-opml-apply-job.use-case';
import { ProcessOpmlParseJobUseCase } from '../src/modules/opml-imports/application/process-opml-parse-job.use-case';
import { buildNormalizedFeedUrlHash, normalizeFeedUrl } from '../src/modules/opml-imports/domain/url-normalizer';
import { OpmlImportsRepository } from '../src/modules/opml-imports/opml-imports.repository';

class FakeRedis {
  async ping(): Promise<string> {
    return 'PONG';
  }

  async quit(): Promise<void> {
    return undefined;
  }
}

class FakeFetchQueue {
  readonly jobs: FetchFeedJobData[] = [];

  async enqueue(job: FetchFeedJobData): Promise<void> {
    this.jobs.push(job);
  }

  createWorker() {
    throw new Error('not_used_in_worker_phase4_integration');
  }
}

class FakeAlertDeliveryQueue {
  readonly jobs: AlertDeliveryJobData[] = [];

  async enqueue(job: AlertDeliveryJobData): Promise<void> {
    this.jobs.push(job);
  }

  createWorker() {
    throw new Error('not_used_in_worker_phase4_integration');
  }
}

class FakeOpmlParseQueue {
  readonly jobs: OpmlParsePreviewJobData[] = [];

  async enqueue(job: OpmlParsePreviewJobData): Promise<void> {
    this.jobs.push(job);
  }

  createWorker() {
    throw new Error('not_used_in_worker_phase4_integration');
  }
}

class FakeOpmlApplyQueue {
  readonly jobs: OpmlApplyImportJobData[] = [];

  async enqueue(job: OpmlApplyImportJobData): Promise<void> {
    this.jobs.push(job);
  }

  createWorker() {
    throw new Error('not_used_in_worker_phase4_integration');
  }
}

async function bootstrapSchema(pool: { query: (sql: string, params?: unknown[]) => Promise<unknown> }): Promise<void> {
  const schema = [
    `CREATE TABLE feeds (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'legacy',
      url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      poll_interval_seconds INT NOT NULL DEFAULT 1800,
      normalized_url_hash TEXT
    )`,
    `CREATE UNIQUE INDEX idx_feeds_tenant_url_unique
      ON feeds (tenant_id, url)`,
    `CREATE UNIQUE INDEX idx_feeds_tenant_normalized_url_hash_unique
      ON feeds (tenant_id, normalized_url_hash)
      WHERE normalized_url_hash IS NOT NULL`,
    `CREATE TABLE opml_imports (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'legacy',
      status TEXT NOT NULL CHECK (status IN ('uploaded', 'parsing', 'preview_ready', 'importing', 'completed', 'failed_validation', 'failed')),
      file_name TEXT NOT NULL,
      file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes >= 0),
      source_checksum TEXT,
      error_message TEXT,
      total_items INT NOT NULL DEFAULT 0 CHECK (total_items >= 0),
      valid_items INT NOT NULL DEFAULT 0 CHECK (valid_items >= 0),
      duplicate_items INT NOT NULL DEFAULT 0 CHECK (duplicate_items >= 0),
      existing_items INT NOT NULL DEFAULT 0 CHECK (existing_items >= 0),
      invalid_items INT NOT NULL DEFAULT 0 CHECK (invalid_items >= 0),
      imported_items INT NOT NULL DEFAULT 0 CHECK (imported_items >= 0),
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE opml_import_items (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'legacy',
      import_id BIGINT NOT NULL REFERENCES opml_imports(id) ON DELETE CASCADE,
      title TEXT,
      outline_path TEXT,
      source_xml_url TEXT,
      normalized_url TEXT,
      normalized_url_hash TEXT,
      feed_id INT REFERENCES feeds(id) ON DELETE SET NULL,
      item_status TEXT NOT NULL CHECK (item_status IN ('new', 'existing', 'duplicate', 'invalid', 'imported', 'failed')),
      validation_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX idx_opml_import_items_dedupe_per_import
      ON opml_import_items (import_id, normalized_url_hash)
      WHERE normalized_url_hash IS NOT NULL AND item_status <> 'duplicate'`,
  ];

  for (const statement of schema) {
    await pool.query(statement);
  }
}

describe('OPML workers fase 4 (parse/apply reales)', () => {
  let app: INestApplication;
  let fakeParseQueue: FakeOpmlParseQueue;
  let fakeApplyQueue: FakeOpmlApplyQueue;
  let fakeFetchQueue: FakeFetchQueue;

  let createUseCase: CreateOpmlImportUseCase;
  let confirmUseCase: ConfirmOpmlImportUseCase;
  let processParseUseCase: ProcessOpmlParseJobUseCase;
  let processApplyUseCase: ProcessOpmlApplyJobUseCase;
  let opmlImportsRepository: OpmlImportsRepository;
  let dbPool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };

  beforeAll(async () => {
    const db = newDb({ autoCreateForeignKeyIndices: true });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    await bootstrapSchema(pool);
    dbPool = pool;

    fakeFetchQueue = new FakeFetchQueue();
    const fakeAlertQueue = new FakeAlertDeliveryQueue();
    fakeParseQueue = new FakeOpmlParseQueue();
    fakeApplyQueue = new FakeOpmlApplyQueue();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DATABASE_POOL)
      .useValue(pool)
      .overrideProvider(REDIS_CONNECTION)
      .useValue(new FakeRedis())
      .overrideProvider(FETCH_FEED_QUEUE_TOKEN)
      .useValue(fakeFetchQueue)
      .overrideProvider(FetchFeedQueue)
      .useValue(fakeFetchQueue)
      .overrideProvider(ALERT_DELIVERY_QUEUE_TOKEN)
      .useValue(fakeAlertQueue)
      .overrideProvider(AlertDeliveryQueue)
      .useValue(fakeAlertQueue)
      .overrideProvider(OPML_PARSE_PREVIEW_QUEUE_TOKEN)
      .useValue(fakeParseQueue)
      .overrideProvider(OpmlParsePreviewQueue)
      .useValue(fakeParseQueue)
      .overrideProvider(OPML_APPLY_IMPORT_QUEUE_TOKEN)
      .useValue(fakeApplyQueue)
      .overrideProvider(OpmlApplyImportQueue)
      .useValue(fakeApplyQueue)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    createUseCase = moduleRef.get(CreateOpmlImportUseCase);
    confirmUseCase = moduleRef.get(ConfirmOpmlImportUseCase);
    processParseUseCase = moduleRef.get(ProcessOpmlParseJobUseCase);
    processApplyUseCase = moduleRef.get(ProcessOpmlApplyJobUseCase);
    opmlImportsRepository = moduleRef.get(OpmlImportsRepository);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    fakeParseQueue.jobs.length = 0;
    fakeApplyQueue.jobs.length = 0;
    fakeFetchQueue.jobs.length = 0;
    await dbPool.query('DELETE FROM opml_import_items');
    await dbPool.query('DELETE FROM opml_imports');
    await dbPool.query('DELETE FROM feeds');
  });

  it('procesa flujo completo async: uploaded -> parsing -> preview_ready -> importing -> completed', async () => {
    await dbPool.query('INSERT INTO feeds(url, normalized_url_hash) VALUES ($1, $2)', [
      'https://existing.example.com/',
      buildNormalizedFeedUrlHash(normalizeFeedUrl('https://existing.example.com')),
    ]);

    const opml = `<?xml version="1.0"?>
      <opml version="2.0">
        <body>
          <outline text="Tech">
            <outline text="New feed" xmlUrl="https://new.example.com/feed.xml" />
            <outline text="Duplicate same" xmlUrl="https://new.example.com/feed.xml" />
            <outline text="Duplicate normalized" xmlUrl="https://new.example.com/feed.xml/" />
            <outline text="Existing" xmlUrl="https://existing.example.com" />
            <outline text="Invalid" xmlUrl="ftp://invalid.example.com/rss" />
          </outline>
        </body>
      </opml>`;

    const created = await createUseCase.execute({
      fileName: 'fase4.opml',
      mimeType: 'text/x-opml',
      content: Buffer.from(opml, 'utf8'),
    });

    expect(created.status).toBe('uploaded');
    expect(fakeParseQueue.jobs).toHaveLength(1);

    const importId = Number(created.id);
    await processParseUseCase.execute(fakeParseQueue.jobs[0]);

    const afterParse = await opmlImportsRepository.getImportOrThrow(importId);
    expect(afterParse.status).toBe('preview_ready');
    expect(afterParse.totalItems).toBe(5);
    expect(afterParse.invalidItems).toBe(1);
    expect(afterParse.duplicateItems).toBe(2);
    expect(afterParse.validItems).toBeGreaterThanOrEqual(2);

    const confirmed = await confirmUseCase.execute(importId);
    expect(confirmed.status).toBe('queued');
    expect(fakeApplyQueue.jobs).toHaveLength(1);

    await processApplyUseCase.execute(fakeApplyQueue.jobs[0]);

    const afterApply = await opmlImportsRepository.getImportOrThrow(importId);
    expect(afterApply.status).toBe('completed');
    expect(afterApply.importedItems).toBeGreaterThanOrEqual(1);

    const grouped = await opmlImportsRepository.countItemsByStatus(importId);
    expect(grouped.imported ?? 0).toBeGreaterThanOrEqual(1);
    expect(grouped.duplicate).toBe(2);
    expect(grouped.invalid).toBe(1);
    expect(grouped.failed ?? 0).toBe(0);
    expect(fakeFetchQueue.jobs.length).toBeGreaterThanOrEqual(1);
  });

  it('marca failed con fallo parcial y mantiene conteos consistentes', async () => {
    const candidateUrl = normalizeFeedUrl('https://candidate.example.com/rss');

    const opml = `<opml version="2.0"><body><outline text="Candidate" xmlUrl="${candidateUrl}" /></body></opml>`;

    const created = await createUseCase.execute({
      fileName: 'collision.opml',
      mimeType: 'text/x-opml',
      content: Buffer.from(opml, 'utf8'),
    });

    const importId = Number(created.id);
    await processParseUseCase.execute(fakeParseQueue.jobs[0]);

    await dbPool.query(
      `UPDATE opml_import_items
       SET normalized_url = NULL, normalized_url_hash = NULL
       WHERE id = (SELECT id FROM opml_import_items WHERE import_id = $1 AND item_status = 'new' ORDER BY id ASC LIMIT 1)`,
      [importId],
    );

    await confirmUseCase.execute(importId);
    await processApplyUseCase.execute(fakeApplyQueue.jobs[0]);

    const afterApply = await opmlImportsRepository.getImportOrThrow(importId);
    expect(afterApply.status).toBe('failed');
    expect(afterApply.errorMessage).toContain('partial_import_failure:1');

    const grouped = await opmlImportsRepository.countItemsByStatus(importId);
    expect(grouped.failed).toBe(1);
    expect(afterApply.importedItems).toBe(0);
    expect(fakeFetchQueue.jobs).toHaveLength(0);
  });
});
