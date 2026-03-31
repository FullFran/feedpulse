import { OpmlImportObservabilityService } from '../src/modules/opml-imports/application/opml-import-observability.service';

describe('OPML observability metrics', () => {
  it('registra métricas de duración para parse/apply', async () => {
    const observability = new OpmlImportObservabilityService();

    const stopParse = observability.startJobTimer('parse');
    const stopApply = observability.startJobTimer('apply');

    stopParse('success');
    stopApply('success');

    const histogram = (observability as any).jobDurationMs;
    const histogramSnapshot = await histogram.get();
    expect(histogramSnapshot.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ labels: { stage: 'parse', status: 'success' } }),
        expect.objectContaining({ labels: { stage: 'apply', status: 'success' } }),
      ]),
    );
  });

  it('registra contador de errores OPML por etapa', async () => {
    const observability = new OpmlImportObservabilityService();
    const stopTimer = observability.startJobTimer('parse');

    stopTimer('error', 'parse_failed');

    const counter = (observability as any).jobErrorsTotal;
    const counterSnapshot = await counter.get();
    expect(counterSnapshot.values).toEqual(
      expect.arrayContaining([expect.objectContaining({ labels: { stage: 'parse', error_code: 'parse_failed' } })]),
    );
  });
});
