import {
  assertValidOpmlImportStatusTransition,
  canTransitionOpmlImportStatus,
  isOpmlImportStatus,
} from '../src/modules/opml-imports/domain/opml-import-status';

describe('opml import status transitions', () => {
  it('accepts known statuses', () => {
    expect(isOpmlImportStatus('uploaded')).toBe(true);
    expect(isOpmlImportStatus('preview_ready')).toBe(true);
    expect(isOpmlImportStatus('unknown')).toBe(false);
  });

  it('allows valid forward transitions', () => {
    expect(canTransitionOpmlImportStatus('uploaded', 'parsing')).toBe(true);
    expect(canTransitionOpmlImportStatus('parsing', 'preview_ready')).toBe(true);
    expect(canTransitionOpmlImportStatus('preview_ready', 'importing')).toBe(true);
    expect(canTransitionOpmlImportStatus('importing', 'completed')).toBe(true);
  });

  it('allows terminal states to stay unchanged for idempotent updates', () => {
    expect(canTransitionOpmlImportStatus('completed', 'completed')).toBe(true);
    expect(canTransitionOpmlImportStatus('failed', 'failed')).toBe(true);
  });

  it('rejects invalid transitions', () => {
    expect(canTransitionOpmlImportStatus('uploaded', 'completed')).toBe(false);
    expect(canTransitionOpmlImportStatus('failed_validation', 'parsing')).toBe(false);
    expect(() => assertValidOpmlImportStatusTransition('preview_ready', 'completed')).toThrow(
      'invalid_opml_import_status_transition:preview_ready->completed',
    );
  });
});
