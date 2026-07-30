import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../infrastructure/persistence/database.service';
import { OpmlImportStatus } from './domain/opml-import-status';

type QueryExecutor = Pick<DatabaseService, 'query'>;

export interface OpmlImportItemInput {
  title: string | null;
  outlinePath: string | null;
  sourceXmlUrl: string;
  normalizedUrl: string | null;
  normalizedUrlHash: string | null;
  itemStatus: 'new' | 'existing' | 'duplicate' | 'invalid' | 'imported' | 'failed';
  validationError: string | null;
}

export interface OpmlImportSummary {
  id: string;
  status: OpmlImportStatus;
  fileName: string;
  fileSizeBytes: number;
  sourceChecksum: string | null;
  errorMessage: string | null;
  totalItems: number;
  validItems: number;
  duplicateItems: number;
  existingItems: number;
  invalidItems: number;
  importedItems: number;
  uploadedAt: string;
  confirmedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OpmlImportPreviewItem {
  id: string;
  title: string | null;
  outlinePath: string | null;
  sourceXmlUrl: string | null;
  normalizedUrl: string | null;
  itemStatus: 'new' | 'existing' | 'duplicate' | 'invalid' | 'imported' | 'failed';
  validationError: string | null;
  feedId: number | null;
}

interface OpmlImportRow {
  id: string;
  tenant_id: string;
  status: OpmlImportStatus;
  file_name: string;
  file_size_bytes: string;
  source_checksum: string | null;
  error_message: string | null;
  total_items: number;
  valid_items: number;
  duplicate_items: number;
  existing_items: number;
  invalid_items: number;
  imported_items: number;
  uploaded_at: Date;
  confirmed_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface OpmlImportItemRow {
  id: string;
  title: string | null;
  outline_path: string | null;
  source_xml_url: string | null;
  normalized_url: string | null;
  item_status: 'new' | 'existing' | 'duplicate' | 'invalid' | 'imported' | 'failed';
  validation_error: string | null;
  feed_id: number | null;
}

function mapImport(row: OpmlImportRow): OpmlImportSummary {
  return {
    id: row.id,
    status: row.status,
    fileName: row.file_name,
    fileSizeBytes: Number(row.file_size_bytes),
    sourceChecksum: row.source_checksum,
    errorMessage: row.error_message,
    totalItems: row.total_items,
    validItems: row.valid_items,
    duplicateItems: row.duplicate_items,
    existingItems: row.existing_items,
    invalidItems: row.invalid_items,
    importedItems: row.imported_items,
    uploadedAt: row.uploaded_at.toISOString(),
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapPreviewItem(row: OpmlImportItemRow): OpmlImportPreviewItem {
  return {
    id: row.id,
    title: row.title,
    outlinePath: row.outline_path,
    sourceXmlUrl: row.source_xml_url,
    normalizedUrl: row.normalized_url,
    itemStatus: row.item_status,
    validationError: row.validation_error,
    feedId: row.feed_id,
  };
}

@Injectable()
export class OpmlImportsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async getImportTenantId(importId: number, executor: QueryExecutor = this.databaseService): Promise<string> {
    const result = await executor.query<{ tenant_id: string }>('SELECT tenant_id FROM opml_imports WHERE id = $1', [
      importId,
    ]);
    const row = result.rows[0];
    if (!row) {
      throw new NotFoundException('opml_import_not_found');
    }
    return row.tenant_id;
  }

  async createImport(input: {
    tenantId: string;
    fileName: string;
    fileSizeBytes: number;
    sourceChecksum: string;
  }): Promise<OpmlImportSummary> {
    const result = await this.databaseService.query<OpmlImportRow>(
      `
        INSERT INTO opml_imports (tenant_id, status, file_name, file_size_bytes, source_checksum)
        VALUES ($1, 'uploaded', $2, $3, $4)
        RETURNING *
      `,
      [input.tenantId, input.fileName, input.fileSizeBytes, input.sourceChecksum],
    );

    const row = result.rows[0];

    if (!row) {
      // `INSERT ... RETURNING *` always yields exactly one row. The guard is
      // here so the impossible case fails loudly instead of dereferencing
      // `undefined` inside `mapImport`.
      throw new Error('opml_import_insert_returned_no_row');
    }

    return mapImport(row);
  }

  /**
   * Tenant-scoped import lookup.
   *
   * TODO(tenant-isolation): make `tenantId` required and let the queue consumers call
   * `findImportByIdForWorker` / `getImportOrThrowForWorker` explicitly. Blocked by three files
   * outside this unit's edit scope, all of which call it with no tenant:
   * `opml-imports/application/process-opml-parse-job.use-case.ts`,
   * `opml-imports/application/process-opml-apply-job.use-case.ts` and
   * `test/opml-workers.phase4.integration-spec.ts`. Until then an omitted tenant id is routed
   * through the worker method, so the widening is explicit in one place rather than hidden in
   * a SQL branch.
   */
  async findImportById(
    importId: number,
    tenantId?: string,
    executor: QueryExecutor = this.databaseService,
  ): Promise<OpmlImportSummary | null> {
    return tenantId === undefined
      ? this.findImportByIdForWorker(importId, executor)
      : this.findImportByIdForTenant(importId, tenantId, executor);
  }

  /** Tenant-scoped import lookup with a REQUIRED tenant id. */
  async findImportByIdForTenant(
    importId: number,
    tenantId: string,
    executor: QueryExecutor = this.databaseService,
  ): Promise<OpmlImportSummary | null> {
    const result = await executor.query<OpmlImportRow>('SELECT * FROM opml_imports WHERE id = $1 AND tenant_id = $2', [
      importId,
      tenantId,
    ]);
    return result.rows[0] ? mapImport(result.rows[0]) : null;
  }

  /**
   * Deliberately cross-tenant import lookup for the OPML queue consumers, which receive a bare
   * import id and read the tenant off the row. Never reachable from an HTTP handler. Grep for
   * this name to enumerate every cross-tenant import read.
   */
  async findImportByIdForWorker(
    importId: number,
    executor: QueryExecutor = this.databaseService,
  ): Promise<OpmlImportSummary | null> {
    const result = await executor.query<OpmlImportRow>('SELECT * FROM opml_imports WHERE id = $1', [importId]);
    return result.rows[0] ? mapImport(result.rows[0]) : null;
  }

  /** See the TODO on `findImportById`: same transitional optional-tenant surface. */
  async getImportOrThrow(
    importId: number,
    tenantId?: string,
    executor: QueryExecutor = this.databaseService,
  ): Promise<OpmlImportSummary> {
    const found = await this.findImportById(importId, tenantId, executor);
    if (!found) {
      throw new NotFoundException('opml_import_not_found');
    }

    return found;
  }

  /** Tenant-scoped variant with a REQUIRED tenant id. */
  async getImportOrThrowForTenant(
    importId: number,
    tenantId: string,
    executor: QueryExecutor = this.databaseService,
  ): Promise<OpmlImportSummary> {
    const found = await this.findImportByIdForTenant(importId, tenantId, executor);
    if (!found) {
      throw new NotFoundException('opml_import_not_found');
    }

    return found;
  }

  /** Deliberately cross-tenant variant for the OPML queue consumers. */
  async getImportOrThrowForWorker(
    importId: number,
    executor: QueryExecutor = this.databaseService,
  ): Promise<OpmlImportSummary> {
    const found = await this.findImportByIdForWorker(importId, executor);
    if (!found) {
      throw new NotFoundException('opml_import_not_found');
    }

    return found;
  }

  async markImportStatus(
    importId: number,
    input: {
      status: OpmlImportStatus;
      errorMessage?: string | null;
      confirmed?: boolean;
      completed?: boolean;
      counters?: Partial<
        Pick<
          OpmlImportSummary,
          'totalItems' | 'validItems' | 'duplicateItems' | 'existingItems' | 'invalidItems' | 'importedItems'
        >
      >;
    },
    executor: QueryExecutor = this.databaseService,
  ): Promise<OpmlImportSummary> {
    const result = await executor.query<OpmlImportRow>(
      `
        UPDATE opml_imports
        SET status = $2,
            error_message = COALESCE($3, error_message),
            total_items = COALESCE($4, total_items),
            valid_items = COALESCE($5, valid_items),
            duplicate_items = COALESCE($6, duplicate_items),
            existing_items = COALESCE($7, existing_items),
            invalid_items = COALESCE($8, invalid_items),
            imported_items = COALESCE($9, imported_items),
            confirmed_at = CASE WHEN $10::boolean THEN COALESCE(confirmed_at, NOW()) ELSE confirmed_at END,
            completed_at = CASE WHEN $11::boolean THEN NOW() ELSE completed_at END,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        importId,
        input.status,
        input.errorMessage ?? null,
        input.counters?.totalItems,
        input.counters?.validItems,
        input.counters?.duplicateItems,
        input.counters?.existingItems,
        input.counters?.invalidItems,
        input.counters?.importedItems,
        input.confirmed ?? false,
        input.completed ?? false,
      ],
    );

    if (!result.rows[0]) {
      throw new NotFoundException('opml_import_not_found');
    }

    return mapImport(result.rows[0]);
  }

  async replaceImportItems(
    importId: number,
    items: OpmlImportItemInput[],
    executor: QueryExecutor = this.databaseService,
  ): Promise<void> {
    const tenantId = await this.getImportTenantId(importId, executor);
    await executor.query('DELETE FROM opml_import_items WHERE import_id = $1', [importId]);

    for (const item of items) {
      await executor.query(
        `
          INSERT INTO opml_import_items (tenant_id, import_id, title, outline_path, source_xml_url, normalized_url, normalized_url_hash, item_status, validation_error)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
        [
          tenantId,
          importId,
          item.title,
          item.outlinePath,
          item.sourceXmlUrl,
          item.normalizedUrl,
          item.normalizedUrlHash,
          item.itemStatus,
          item.validationError,
        ],
      );
    }
  }

  /**
   * Item-level queries below key on `import_id` alone rather than on `tenant_id`.
   *
   * That is safe because `opml_import_items.import_id` is a FK onto `opml_imports`, whose
   * ownership is already checked by `getImportOrThrowForTenant` before any of these run, and
   * the DB assigns `opml_import_items.tenant_id` from the parent import. It is NOT safe to
   * call any of them with an import id that has not first been resolved for the caller's
   * tenant.
   */
  async listPreviewItems(
    importId: number,
    page: number,
    pageSize: number,
  ): Promise<{ items: OpmlImportPreviewItem[]; total: number }> {
    const offset = (page - 1) * pageSize;
    const [itemsResult, totalResult] = await Promise.all([
      this.databaseService.query<OpmlImportItemRow>(
        `
          SELECT id, title, outline_path, source_xml_url, normalized_url, item_status, validation_error, feed_id
          FROM opml_import_items
          WHERE import_id = $1
          ORDER BY id ASC
          LIMIT $2 OFFSET $3
        `,
        [importId, pageSize, offset],
      ),
      this.databaseService.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM opml_import_items WHERE import_id = $1',
        [importId],
      ),
    ]);

    return {
      items: itemsResult.rows.map(mapPreviewItem),
      total: Number(totalResult.rows[0]?.count ?? '0'),
    };
  }

  async listNewCandidateItems(
    importId: number,
    executor: QueryExecutor = this.databaseService,
  ): Promise<OpmlImportPreviewItem[]> {
    const result = await executor.query<OpmlImportItemRow>(
      `
        SELECT id, title, outline_path, source_xml_url, normalized_url, item_status, validation_error, feed_id
        FROM opml_import_items
        WHERE import_id = $1 AND item_status = 'new'
        ORDER BY id ASC
      `,
      [importId],
    );

    return result.rows.map(mapPreviewItem);
  }

  async markItemImported(
    itemId: number,
    feedId: number,
    executor: QueryExecutor = this.databaseService,
  ): Promise<void> {
    await executor.query(
      `
        UPDATE opml_import_items
        SET item_status = 'imported',
            feed_id = $2,
            updated_at = NOW()
        WHERE id = $1
      `,
      [itemId, feedId],
    );
  }

  async markItemFailed(
    itemId: number,
    validationError: string,
    executor: QueryExecutor = this.databaseService,
  ): Promise<void> {
    await executor.query(
      `
        UPDATE opml_import_items
        SET item_status = 'failed',
            validation_error = $2,
            updated_at = NOW()
        WHERE id = $1
      `,
      [itemId, validationError],
    );
  }

  async countItemsByStatus(
    importId: number,
    executor: QueryExecutor = this.databaseService,
  ): Promise<Record<string, number>> {
    const result = await executor.query<{ item_status: string; total: string }>(
      `
        SELECT item_status, COUNT(*)::text AS total
        FROM opml_import_items
        WHERE import_id = $1
        GROUP BY item_status
      `,
      [importId],
    );

    return result.rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.item_status] = Number(row.total);
      return acc;
    }, {});
  }
}
