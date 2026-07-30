process.env.NODE_ENV = 'test';
process.env.PORT = '3002';
process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/rss_monitor_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.LOG_LEVEL = 'error';
process.env.OPML_UPLOAD_MAX_BYTES = '2097152';
process.env.OPML_INITIAL_JITTER_MAX_SECONDS = '1';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { DATABASE_POOL } from '../src/infrastructure/persistence/database.constants';
import { ConfirmOpmlImportUseCase } from '../src/modules/opml-imports/application/confirm-opml-import.use-case';
import { CreateOpmlImportUseCase } from '../src/modules/opml-imports/application/create-opml-import.use-case';
import { ProcessOpmlApplyJobUseCase } from '../src/modules/opml-imports/application/process-opml-apply-job.use-case';
import { ProcessOpmlParseJobUseCase } from '../src/modules/opml-imports/application/process-opml-parse-job.use-case';
import { buildNormalizedFeedUrlHash, normalizeFeedUrl } from '../src/modules/opml-imports/domain/url-normalizer';
import { OpmlImportsRepository } from '../src/modules/opml-imports/opml-imports.repository';
import { expectDefined } from './support/expect-defined';
import type { FakeQueues } from './support/fakes';
import { createFakeQueues, overrideQueueProviders, resetFakeQueues } from './support/fakes';
import type { PgMemPool } from './support/pg-mem';
import { createPgMemPoolWithSchema } from './support/schema';

describe('OPML workers fase 4 (parse/apply reales)', () => {
  let app: INestApplication;
  let queues: FakeQueues;

  let createUseCase: CreateOpmlImportUseCase;
  let confirmUseCase: ConfirmOpmlImportUseCase;
  let processParseUseCase: ProcessOpmlParseJobUseCase;
  let processApplyUseCase: ProcessOpmlApplyJobUseCase;
  let opmlImportsRepository: OpmlImportsRepository;
  let dbPool: PgMemPool;

  beforeAll(async () => {
    const { pool } = await createPgMemPoolWithSchema();
    dbPool = pool;

    queues = createFakeQueues();

    const moduleRef = await overrideQueueProviders(
      Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DATABASE_POOL)
        .useValue(pool),
      queues,
    ).compile();

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
    resetFakeQueues(queues);
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
    expect(queues.opmlParse.jobs).toHaveLength(1);

    const importId = Number(created.id);
    await processParseUseCase.execute(expectDefined(queues.opmlParse.jobs[0]));

    const afterParse = await opmlImportsRepository.getImportOrThrow(importId);
    expect(afterParse.status).toBe('preview_ready');
    expect(afterParse.totalItems).toBe(5);
    expect(afterParse.invalidItems).toBe(1);
    expect(afterParse.duplicateItems).toBe(2);
    expect(afterParse.validItems).toBeGreaterThanOrEqual(2);

    const confirmed = await confirmUseCase.execute(importId);
    expect(confirmed.status).toBe('queued');
    expect(queues.opmlApply.jobs).toHaveLength(1);

    await processApplyUseCase.execute(expectDefined(queues.opmlApply.jobs[0]));

    const afterApply = await opmlImportsRepository.getImportOrThrow(importId);
    expect(afterApply.status).toBe('completed');
    expect(afterApply.importedItems).toBeGreaterThanOrEqual(1);

    const grouped = await opmlImportsRepository.countItemsByStatus(importId);
    expect(grouped.imported ?? 0).toBeGreaterThanOrEqual(1);
    expect(grouped.duplicate).toBe(2);
    expect(grouped.invalid).toBe(1);
    expect(grouped.failed ?? 0).toBe(0);
    expect(queues.fetchFeed.jobs.length).toBeGreaterThanOrEqual(1);
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
    await processParseUseCase.execute(expectDefined(queues.opmlParse.jobs[0]));

    // Occupy the candidate's normalized-url hash with a feed whose stored URL
    // normalizes to something else. The apply INSERT then hits
    // idx_feeds_tenant_normalized_url_hash_unique, the lookup finds a row that
    // is not the same feed, and the item is failed as a hash collision.
    //
    // This used to NULL out normalized_url on a 'new' item instead, which the
    // real schema forbids: migration 0003 declares
    // `opml_import_items_normalized_url_required`. The suite's private schema
    // simply omitted that CHECK, so the case only ever existed in the emulator.
    const tenantResult = await dbPool.query<{ tenant_id: string }>('SELECT tenant_id FROM opml_imports WHERE id = $1', [
      importId,
    ]);

    await dbPool.query('INSERT INTO feeds (tenant_id, url, normalized_url_hash) VALUES ($1, $2, $3)', [
      expectDefined(tenantResult.rows[0]).tenant_id,
      'https://squatter.example.com/rss',
      buildNormalizedFeedUrlHash(candidateUrl),
    ]);

    await confirmUseCase.execute(importId);
    await processApplyUseCase.execute(expectDefined(queues.opmlApply.jobs[0]));

    const afterApply = await opmlImportsRepository.getImportOrThrow(importId);
    expect(afterApply.status).toBe('failed');
    expect(afterApply.errorMessage).toContain('partial_import_failure:1');

    const grouped = await opmlImportsRepository.countItemsByStatus(importId);
    expect(grouped.failed).toBe(1);
    expect(afterApply.importedItems).toBe(0);
    expect(queues.fetchFeed.jobs).toHaveLength(0);
  });
});
