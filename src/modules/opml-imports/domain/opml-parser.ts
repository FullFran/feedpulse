export interface ParsedOpmlItem {
  title: string | null;
  outlinePath: string | null;
  sourceXmlUrl: string;
}

export interface ExtractOpmlItemsOptions {
  maxBytes?: number;
  maxOutlineTags?: number;
}

const DEFAULT_MAX_OPML_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_OUTLINE_TAGS = 20_000;

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const raw = tag.replace(/^<\/?\s*outline\b/i, '').replace(/\/?\s*>$/, '');
  const attrRegex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

  let match: RegExpExecArray | null = attrRegex.exec(raw);
  while (match) {
    const key = match[1];
    const value = match[3] ?? match[4] ?? '';
    attributes[key] = decodeXmlEntities(value.trim());
    match = attrRegex.exec(raw);
  }

  return attributes;
}

/**
 * Extracts OPML outline items in a streaming-friendly way without executing any external entities.
 */
export function extractOpmlItems(opmlXml: string, options: ExtractOpmlItemsOptions = {}): ParsedOpmlItem[] {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_OPML_BYTES;
  const maxOutlineTags = options.maxOutlineTags ?? DEFAULT_MAX_OUTLINE_TAGS;

  if (Buffer.byteLength(opmlXml, 'utf8') > maxBytes) {
    throw new Error('opml_too_large');
  }

  const xml = opmlXml.trim();
  if (!xml || !xml.toLowerCase().includes('<opml')) {
    throw new Error('opml_invalid_root');
  }

  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    throw new Error('opml_doctype_not_allowed');
  }

  const tags = xml.match(/<\/?\s*outline\b[^>]*>/gi);
  if (!tags || tags.length === 0) {
    return [];
  }

  if (tags.length > maxOutlineTags) {
    throw new Error('opml_outline_limit_exceeded');
  }

  const pathStack: string[] = [];
  const parsed: ParsedOpmlItem[] = [];

  for (const tag of tags) {
    const trimmedTag = tag.trim();
    const isClosing = /^<\/\s*outline/i.test(trimmedTag);
    const isSelfClosing = /\/>$/.test(trimmedTag);

    if (isClosing) {
      if (!pathStack.length) {
        throw new Error('opml_malformed_outline');
      }

      pathStack.pop();
      continue;
    }

    const attributes = parseAttributes(trimmedTag);
    const title = (attributes.title ?? attributes.text ?? '').trim() || null;
    const xmlUrl = (attributes.xmlUrl ?? attributes.xmlurl ?? '').trim();

    if (xmlUrl) {
      const outlinePath = [...pathStack, ...(title ? [title] : [])].join(' / ').trim();
      parsed.push({
        title,
        outlinePath: outlinePath || null,
        sourceXmlUrl: xmlUrl,
      });
      continue;
    }

    if (!isSelfClosing && title) {
      pathStack.push(title);
    }
  }

  if (pathStack.length > 0) {
    throw new Error('opml_malformed_outline');
  }

  return parsed;
}
