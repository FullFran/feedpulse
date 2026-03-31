import { extractOpmlItems } from '../src/modules/opml-imports/domain/opml-parser';

describe('extractOpmlItems', () => {
  it('extracts xmlUrl entries and keeps folder path context', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <opml version="2.0">
        <body>
          <outline text="Tech">
            <outline text="AI Feed" xmlUrl="https://example.com/ai.xml" />
          </outline>
          <outline text="News" xmlUrl="https://example.com/news.xml" />
        </body>
      </opml>`;

    const parsed = extractOpmlItems(xml);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      title: 'AI Feed',
      outlinePath: 'Tech / AI Feed',
      sourceXmlUrl: 'https://example.com/ai.xml',
    });
    expect(parsed[1].outlinePath).toBe('News');
  });

  it('fails for malformed outline nesting', () => {
    const malformed = `<opml><body><outline text="A"></body></opml>`;
    expect(() => extractOpmlItems(malformed)).toThrow('opml_malformed_outline');
  });

  it('rejects XML with doctype/entity declarations (XXE hardening)', () => {
    const xmlWithDoctype = `<?xml version="1.0"?>
      <!DOCTYPE opml [
        <!ENTITY xxe SYSTEM "file:///etc/passwd">
      ]>
      <opml version="2.0"><body><outline text="A" xmlUrl="https://example.com/rss"/></body></opml>`;

    expect(() => extractOpmlItems(xmlWithDoctype)).toThrow('opml_doctype_not_allowed');
  });

  it('enforces configurable outline tag limits', () => {
    const xml = `<opml><body><outline text="A" xmlUrl="https://example.com/a.xml"/><outline text="B" xmlUrl="https://example.com/b.xml"/></body></opml>`;
    expect(() => extractOpmlItems(xml, { maxOutlineTags: 1 })).toThrow('opml_outline_limit_exceeded');
  });
});
