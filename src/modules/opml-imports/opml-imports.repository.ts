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

  async createImport(input: { fileName: string; fileSizeBytes: number; sourceChecksum: string }): Promise<OpmlImportSummary> {
    const result = await this.databaseService.query<OpmlImportRow>(
      `
        INSERT INTO opml_imports (status, file_name, file_size_bytes, source_checksum)
        VALUES ('uploaded', $1, $2, $3)
        RETURNING *
      `,
      [input.fileName, input.fileSizeBytes, input.sourceChecksum],
    );

    return mapImport(result.rows[0]);
  }

  async findImportById(importId: number, executor: QueryExecutor = this.databaseService): Promise<OpmlImportSummary | null> {
    const result = await executor.query<OpmlImportRow>('SELECT * FROM opml_imports WHERE id = $1', [importId]);
    return result.rows[0] ? mapImport(result.rows[0]) : null;
  }

  async getImportOrThrow(importId: number, executor: QueryExecutor = this.databaseService): Promise<OpmlImportSummary> {
    const found = await this.findImportById(importId, executor);
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
      counters?: Partial<Pick<OpmlImportSummary, 'totalItems' | 'validItems' | 'duplicateItems' | 'existingItems' | 'invalidItems' | 'importedItems'>>;
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

  async replaceImportItems(importId: number, items: OpmlImportItemInput[], executor: QueryExecutor = this.databaseService): Promise<void> {
    await executor.query('DELETE FROM opml_import_items WHERE import_id = $1', [importId]);

    for (const item of items) {
      await executor.query(
        `
          INSERT INTO opml_import_items (import_id, title, outline_path, source_xml_url, normalized_url, normalized_url_hash, item_status, validation_error)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [importId, item.title, item.outlinePath, item.sourceXmlUrl, item.normalizedUrl, item.normalizedUrlHash, item.itemStatus, item.validationError],
      );
    }
  }

  async listPreviewItems(importId: number, page: number, pageSize: number): Promise<{ items: OpmlImportPreviewItem[]; total: number }> {
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
      this.databaseService.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM opml_import_items WHERE import_id = $1', [importId]),
    ]);

    return {
      items: itemsResult.rows.map(mapPreviewItem),
      total: Number(totalResult.rows[0]?.count ?? '0'),
    };
  }

  async listNewCandidateItems(importId: number, executor: QueryExecutor = this.databaseService): Promise<OpmlImportPreviewItem[]> {
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

  async markItemImported(itemId: number, feedId: number, executor: QueryExecutor = this.databaseService): Promise<void> {
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

  async markItemFailed(itemId: number, validationError: string, executor: QueryExecutor = this.databaseService): Promise<void> {
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

  async countItemsByStatus(importId: number, executor: QueryExecutor = this.databaseService): Promise<Record<string, number>> {
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
