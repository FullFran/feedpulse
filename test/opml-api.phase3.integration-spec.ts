process.env.NODE_ENV = 'test';
process.env.PORT = '3002';
process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/rss_monitor_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.LOG_LEVEL = 'error';
process.env.OPML_UPLOAD_MAX_BYTES = '64';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { DATABASE_POOL } from '../src/infrastructure/persistence/database.constants';
import { configureApiApplication } from '../src/main/create-api-app';
import { CreateOpmlImportUseCase } from '../src/modules/opml-imports/application/create-opml-import.use-case';
import { OpmlImportsRepository } from '../src/modules/opml-imports/opml-imports.repository';
import type { FakeQueues } from './support/fakes';
import { createFakeQueues, overrideQueueProviders, resetFakeQueues } from './support/fakes';
import { createPgMemPoolWithSchema } from './support/schema';

describe('OPML API (phase 3 backend, no workers)', () => {
  let app: INestApplication;
  let opmlImportsRepository: OpmlImportsRepository;
  let createOpmlImportUseCase: CreateOpmlImportUseCase;
  let queues: FakeQueues;

  beforeAll(async () => {
    const { pool } = await createPgMemPoolWithSchema();

    queues = createFakeQueues();

    const moduleRef = await overrideQueueProviders(
      Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DATABASE_POOL)
        .useValue(pool),
      queues,
    ).compile();

    app = moduleRef.createNestApplication();
    configureApiApplication(app);
    await app.init();

    opmlImportsRepository = moduleRef.get(OpmlImportsRepository);
    createOpmlImportUseCase = moduleRef.get(CreateOpmlImportUseCase);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(() => {
    resetFakeQueues(queues);
  });

  it('uploads a valid OPML file and creates an import with a queued parse job (stub)', async () => {
    const uploadResponse = await request(app.getHttpServer())
      .post('/api/v1/opml/imports')
      .attach('file', Buffer.from('<opml><body/></opml>', 'utf8'), {
        filename: 'feeds.opml',
        contentType: 'text/x-opml',
      })
      .expect(201);

    expect(uploadResponse.body.data.status).toBe('uploaded');
    expect(uploadResponse.body.data.parseQueued).toBe(true);
    expect(queues.opmlParse.jobs).toHaveLength(1);
  });

  it('rejects uploads with an invalid type or an oversized body', async () => {
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

  it('aborts an oversized upload at the multipart layer and keeps the opml_file_too_large contract', async () => {
    const executeSpy = jest.spyOn(createOpmlImportUseCase, 'execute');

    // 512 KiB against an OPML_UPLOAD_MAX_BYTES of 64: multer must stop reading well
    // before the whole body is buffered into a Buffer for the use case.
    const response = await request(app.getHttpServer())
      .post('/api/v1/opml/imports')
      .attach('file', Buffer.alloc(512 * 1024, 0x78), {
        filename: 'huge.opml',
        contentType: 'text/x-opml',
      })
      .expect(400);

    expect(JSON.stringify(response.body)).toContain('opml_file_too_large');
    // The handler is never invoked, which proves the rejection happened at the edge
    // and not in the downstream defence-in-depth check.
    expect(executeSpy).not.toHaveBeenCalled();
    expect(queues.opmlParse.jobs).toHaveLength(0);

    executeSpy.mockRestore();
  });

  it('exposes a paginated preview by import id with counters', async () => {
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

  it('confirms an import idempotently and reports status and progress', async () => {
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

    const firstConfirm = await request(app.getHttpServer())
      .post(`/api/v1/opml/imports/${importId}/confirm`)
      .expect(202);
    expect(firstConfirm.body.data.status).toBe('queued');
    expect(queues.opmlApply.jobs).toHaveLength(1);

    const secondConfirm = await request(app.getHttpServer())
      .post(`/api/v1/opml/imports/${importId}/confirm`)
      .expect(202);
    expect(secondConfirm.body.data.status).toBe('already_confirmed');
    expect(queues.opmlApply.jobs).toHaveLength(1);

    const statusResponse = await request(app.getHttpServer())
      .get(`/api/v1/opml/imports/${importId}/status`)
      .expect(200);
    expect(statusResponse.body.data.status).toBe('importing');
    expect(statusResponse.body.data.progressPercent).toBe(80);
    expect(statusResponse.body.data.failedItems).toBe(1);
  });
});
