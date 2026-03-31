import { ProcessOpmlParseJobUseCase } from '../src/modules/opml-imports/application/process-opml-parse-job.use-case';
import { buildNormalizedFeedUrlHash, normalizeFeedUrl } from '../src/modules/opml-imports/domain/url-normalizer';
import { OpmlImportItemInput } from '../src/modules/opml-imports/opml-imports.repository';

describe('ProcessOpmlParseJobUseCase', () => {
  it('clasifica entradas ya registradas como existing en preview', async () => {
    const existingUrl = normalizeFeedUrl('https://existing.example.com/feed.xml');
    const existingHash = buildNormalizedFeedUrlHash(existingUrl);

    const replaceImportItems = jest.fn<Promise<void>, [number, OpmlImportItemInput[], unknown]>().mockResolvedValue();
    const markImportStatus = jest.fn().mockImplementation(async (_importId: number, input: { status: string }) => ({
      id: '1',
      status: input.status,
    }));

    const opmlImportsRepository = {
      getImportOrThrow: jest.fn().mockResolvedValue({ id: '1', status: 'uploaded' }),
      markImportStatus,
      replaceImportItems,
    };

    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM feeds')) {
          return {
            rows: [
              {
                id: 12,
                url: existingUrl,
                normalized_url_hash: existingHash,
              },
            ],
          };
        }

        return { rows: [] };
      }),
      release: jest.fn(),
    };

    const databaseService = {
      getPool: () => ({ connect: async () => client }),
    };

    const appConfigService = {
      opmlUploadMaxBytes: 1024 * 1024,
    };

    const observabilityService = {
      startJobTimer: jest.fn().mockReturnValue(jest.fn()),
    };

    const useCase = new ProcessOpmlParseJobUseCase(
      databaseService as never,
      opmlImportsRepository as never,
      appConfigService as never,
      observabilityService as never,
    );

    await useCase.execute({
      importId: 1,
      opmlXml: `<opml version="2.0"><body><outline text="Existing" xmlUrl="${existingUrl}" /></body></opml>`,
    });

    expect(replaceImportItems).toHaveBeenCalledTimes(1);
    const [, parsedItems] = replaceImportItems.mock.calls[0];
    expect(parsedItems).toHaveLength(1);
    expect(parsedItems[0].itemStatus).toBe('existing');
    expect(parsedItems[0].validationError).toBeNull();

    const finalStatusCall = markImportStatus.mock.calls.find(([, input]) => input.status === 'preview_ready');
    expect(finalStatusCall).toBeDefined();
    expect(finalStatusCall?.[1]?.counters?.existingItems).toBe(1);
  });
});
