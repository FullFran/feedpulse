import type { Counter, Histogram } from 'prom-client';
import { OpmlImportObservabilityService } from '../src/modules/opml-imports/application/opml-import-observability.service';

/**
 * The two metrics are private implementation detail of the service — it exposes
 * only `startJobTimer`. Reading them back is the only way to assert the labels
 * actually recorded, so the test takes a typed view of those private fields
 * instead of casting to `any`: a rename or a label-type change then breaks the
 * compile rather than silently making these assertions vacuous.
 */
interface ObservabilityInternals {
  readonly jobDurationMs: Histogram<'stage' | 'status'>;
  readonly jobErrorsTotal: Counter<'stage' | 'error_code'>;
}

function internalsOf(service: OpmlImportObservabilityService): ObservabilityInternals {
  return service as unknown as ObservabilityInternals;
}

describe('OPML observability metrics', () => {
  it('records duration metrics for the parse and apply stages', async () => {
    const observability = new OpmlImportObservabilityService();

    const stopParse = observability.startJobTimer('parse');
    const stopApply = observability.startJobTimer('apply');

    stopParse('success');
    stopApply('success');

    const histogramSnapshot = await internalsOf(observability).jobDurationMs.get();
    expect(histogramSnapshot.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ labels: { stage: 'parse', status: 'success' } }),
        expect.objectContaining({ labels: { stage: 'apply', status: 'success' } }),
      ]),
    );
  });

  it('records the OPML error counter per stage', async () => {
    const observability = new OpmlImportObservabilityService();
    const stopTimer = observability.startJobTimer('parse');

    stopTimer('error', 'parse_failed');

    const counterSnapshot = await internalsOf(observability).jobErrorsTotal.get();
    expect(counterSnapshot.values).toEqual(
      expect.arrayContaining([expect.objectContaining({ labels: { stage: 'parse', error_code: 'parse_failed' } })]),
    );
  });
});
