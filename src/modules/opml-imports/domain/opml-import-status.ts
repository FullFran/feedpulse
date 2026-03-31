export const OPML_IMPORT_STATUSES = [
  'uploaded',
  'parsing',
  'preview_ready',
  'importing',
  'completed',
  'failed_validation',
  'failed',
] as const;

export type OpmlImportStatus = (typeof OPML_IMPORT_STATUSES)[number];

const VALID_OPML_IMPORT_STATUS_TRANSITIONS: Record<OpmlImportStatus, readonly OpmlImportStatus[]> = {
  uploaded: ['parsing', 'failed_validation'],
  parsing: ['preview_ready', 'failed_validation'],
  preview_ready: ['importing', 'failed'],
  importing: ['completed', 'failed'],
  completed: [],
  failed_validation: [],
  failed: [],
};

export function isOpmlImportStatus(value: string): value is OpmlImportStatus {
  return (OPML_IMPORT_STATUSES as readonly string[]).includes(value);
}

export function canTransitionOpmlImportStatus(from: OpmlImportStatus, to: OpmlImportStatus): boolean {
  if (from === to) {
    return true;
  }

  return VALID_OPML_IMPORT_STATUS_TRANSITIONS[from].includes(to);
}

export function assertValidOpmlImportStatusTransition(from: OpmlImportStatus, to: OpmlImportStatus): void {
  if (!canTransitionOpmlImportStatus(from, to)) {
    throw new Error(`invalid_opml_import_status_transition:${from}->${to}`);
  }
}
