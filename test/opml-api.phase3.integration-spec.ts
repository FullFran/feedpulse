process.env.NODE_ENV = 'test';
process.env.PORT = '3002';
process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/rss_monitor_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.LOG_LEVEL = 'error';
process.env.OPML_UPLOAD_MAX_BYTES = '64';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { newDb } from 'pg-mem';
import request from 'supertest';

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
import { configureApiApplication } from '../src/main/create-api-app';
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
    throw new Error('not_used_in_phase3_api_tests');
  }
}

class FakeAlertDeliveryQueue {
  readonly jobs: AlertDeliveryJobData[] = [];

  async enqueue(job: AlertDeliveryJobData): Promise<void> {
    this.jobs.push(job);
  }

  createWorker() {
    throw new Error('not_used_in_phase3_api_tests');
  }
}

class FakeOpmlParseQueue {
  readonly jobs: OpmlParsePreviewJobData[] = [];

  async enqueue(job: OpmlParsePreviewJobData): Promise<void> {
    this.jobs.push(job);
  }

  createWorker() {
    throw new Error('not_used_in_phase3_api_tests');
  }
}

class FakeOpmlApplyQueue {
  readonly jobs: OpmlApplyImportJobData[] = [];

  async enqueue(job: OpmlApplyImportJobData): Promise<void> {
    this.jobs.push(job);
  }

  createWorker() {
    throw new Error('not_used_in_phase3_api_tests');
  }
}

async function bootstrapSchema(pool: { query: (sql: string) => Promise<unknown> }): Promise<void> {
  const schema = [
    `CREATE TABLE feeds (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'legacy',
      url TEXT NOT NULL,
      normalized_url_hash TEXT
    )`,
    `CREATE UNIQUE INDEX idx_feeds_tenant_url_unique ON feeds (tenant_id, url)`,
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
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT opml_import_items_normalized_url_required
        CHECK (item_status = 'invalid' OR (normalized_url IS NOT NULL AND normalized_url_hash IS NOT NULL))
    )`,
    `CREATE UNIQUE INDEX idx_opml_import_items_dedupe_per_import
      ON opml_import_items (import_id, normalized_url_hash)
      WHERE normalized_url_hash IS NOT NULL`,
  ];

  for (const statement of schema) {
    await pool.query(statement);
  }
}

describe('OPML API (fase 3 backend, sin workers)', () => {
  let app: INestApplication;
  let opmlImportsRepository: OpmlImportsRepository;
  let fakeParseQueue: FakeOpmlParseQueue;
  let fakeApplyQueue: FakeOpmlApplyQueue;

  beforeAll(async () => {
    const db = newDb({ autoCreateForeignKeyIndices: true });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    await bootstrapSchema(pool);

    const fakeFetchQueue = new FakeFetchQueue();
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
    configureApiApplication(app);
    await app.init();

    opmlImportsRepository = moduleRef.get(OpmlImportsRepository);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(() => {
    fakeParseQueue.jobs.length = 0;
    fakeApplyQueue.jobs.length = 0;
  });

  it('sube OPML válido y crea import con parse job encolado (stub)', async () => {
    const uploadResponse = await request(app.getHttpServer())
      .post('/api/v1/opml/imports')
      .attach('file', Buffer.from('<opml><body/></opml>', 'utf8'), {
        filename: 'feeds.opml',
        contentType: 'text/x-opml',
      })
      .expect(201);

    expect(uploadResponse.body.data.status).toBe('uploaded');
    expect(uploadResponse.body.data.parseQueued).toBe(true);
    expect(fakeParseQueue.jobs).toHaveLength(1);
  });

  it('rechaza upload inválido por tipo y por tamaño', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/opml/imports')
      .attach('file', Buffer.from('<opml><body/></opml>', 'utf8'), {
        filename: 'feeds.txt',
        contentType: 'text/plain',
      })
      .expect(400);

    await request(app.getHttpServer())
      .post('/api/v1/opml/imports')
      .attach('file', Buffer.from('x'.repeat(80), 'utf8'), {
        filename: 'feeds.opml',
        contentType: 'text/x-opml',
      })
      .expect(400);
  });

  it('expone preview paginado por import_id con conteos', async () => {
    const uploadResponse = await request(app.getHttpServer())
      .post('/api/v1/opml/imports')
      .attach('file', Buffer.from('<opml><body/></opml>', 'utf8'), {
        filename: 'preview.opml',
        contentType: 'text/x-opml',
      })
      .expect(201);

    const importId = Number(uploadResponse.body.data.id);

    await opmlImportsRepository.replaceImportItems(importId, [
      {
        title: 'Feed A',
        outlinePath: 'Folder / Feed A',
        sourceXmlUrl: 'https://example.com/a.xml',
        normalizedUrl: 'https://example.com/a.xml',
        normalizedUrlHash: 'hash-a',
        itemStatus: 'new',
        validationError: null,
      },
      {
        title: 'Feed B',
        outlinePath: 'Folder / Feed B',
        sourceXmlUrl: 'https://example.com/b.xml',
        normalizedUrl: 'https://example.com/b.xml',
        normalizedUrlHash: 'hash-b',
        itemStatus: 'existing',
        validationError: null,
      },
      {
        title: 'Invalid feed',
        outlinePath: 'Folder / Invalid',
        sourceXmlUrl: 'ftp://example.com/nope.xml',
        normalizedUrl: null,
        normalizedUrlHash: null,
        itemStatus: 'invalid',
        validationError: 'feed_url_invalid_scheme',
      },
    ]);

    await opmlImportsRepository.markImportStatus(importId, {
      status: 'preview_ready',
      counters: {
        totalItems: 3,
        validItems: 2,
        existingItems: 1,
        invalidItems: 1,
      },
    });

    const previewResponse = await request(app.getHttpServer())
      .get(`/api/v1/opml/imports/${importId}/preview?page=1&page_size=2`)
      .expect(200);

    expect(previewResponse.body.summary.status).toBe('preview_ready');
    expect(previewResponse.body.summary.totalItems).toBe(3);
    expect(previewResponse.body.summary.invalidItems).toBe(1);
    expect(previewResponse.body.meta.total).toBe(3);
    expect(previewResponse.body.data).toHaveLength(2);
  });

  it('confirma import de forma idempotente y reporta estado/progreso', async () => {
    const uploadResponse = await request(app.getHttpServer())
      .post('/api/v1/opml/imports')
      .attach('file', Buffer.from('<opml><body/></opml>', 'utf8'), {
        filename: 'confirm.opml',
        contentType: 'text/x-opml',
      })
      .expect(201);

    const importId = Number(uploadResponse.body.data.id);

    await opmlImportsRepository.markImportStatus(importId, {
      status: 'preview_ready',
      counters: {
        totalItems: 2,
        validItems: 2,
      },
    });

    await opmlImportsRepository.replaceImportItems(importId, [
      {
        title: 'Imported item',
        outlinePath: null,
        sourceXmlUrl: 'https://example.com/imported.xml',
        normalizedUrl: 'https://example.com/imported.xml',
        normalizedUrlHash: 'hash-imported',
        itemStatus: 'imported',
        validationError: null,
      },
      {
        title: 'Failed item',
        outlinePath: null,
        sourceXmlUrl: 'https://example.com/failed.xml',
        normalizedUrl: 'https://example.com/failed.xml',
        normalizedUrlHash: 'hash-failed',
        itemStatus: 'failed',
        validationError: 'worker_not_running_phase3_stub',
      },
    ]);

    const firstConfirm = await request(app.getHttpServer()).post(`/api/v1/opml/imports/${importId}/confirm`).expect(202);
    expect(firstConfirm.body.data.status).toBe('queued');
    expect(fakeApplyQueue.jobs).toHaveLength(1);

    const secondConfirm = await request(app.getHttpServer()).post(`/api/v1/opml/imports/${importId}/confirm`).expect(202);
    expect(secondConfirm.body.data.status).toBe('already_confirmed');
    expect(fakeApplyQueue.jobs).toHaveLength(1);

    const statusResponse = await request(app.getHttpServer()).get(`/api/v1/opml/imports/${importId}/status`).expect(200);
    expect(statusResponse.body.data.status).toBe('importing');
    expect(statusResponse.body.data.progressPercent).toBe(80);
    expect(statusResponse.body.data.failedItems).toBe(1);
  });
});
