import {
  entryMatchesRule,
  keywordMatches,
  ruleMatchesNormalizedText,
} from '../src/modules/ingestion/domain/keyword-match';
import { normalizeSearchText } from '../src/shared/text/normalize-search-text';

describe('normalizeSearchText', () => {
  it('strips diacritics, lowercases, collapses whitespace and trims', () => {
    expect(normalizeSearchText('  Ocupación   ILEGAL\n\t de una VIVIENDA  ')).toBe('ocupacion ilegal de una vivienda');
  });

  it('is idempotent', () => {
    const once = normalizeSearchText('Café  CON\nLeche');
    expect(normalizeSearchText(once)).toBe(once);
  });

  it('normalizes non-Latin scripts without destroying them', () => {
    expect(normalizeSearchText('Νέα από την Αθήνα')).toBe('νεα απο την αθηνα');
    expect(normalizeSearchText('Новости из Москва')).toBe('новости из москва');
  });
});

describe('keywordMatches', () => {
  it('does not match a keyword that is only a prefix of a longer word', () => {
    expect(keywordMatches(normalizeSearchText('Okupacion de una vivienda'), 'okupa')).toBe(false);
  });

  it('matches the same keyword when it stands alone', () => {
    expect(keywordMatches(normalizeSearchText('Un okupa entro en el piso'), 'okupa')).toBe(true);
  });

  it('matches Cyrillic keywords', () => {
    expect(keywordMatches(normalizeSearchText('Новости из Москва'), 'москва')).toBe(true);
    expect(keywordMatches(normalizeSearchText('Новости из Москвабад'), 'москва')).toBe(false);
  });

  it('matches Greek keywords', () => {
    expect(keywordMatches(normalizeSearchText('Νέα από την Αθήνα'), 'αθηνα')).toBe(true);
  });

  it('matches keywords made of regex metacharacters without throwing', () => {
    expect(() => keywordMatches(normalizeSearchText('Curso de C++ para principiantes'), 'c++')).not.toThrow();
    expect(keywordMatches(normalizeSearchText('Curso de C++ para principiantes'), 'c++')).toBe(true);
    expect(keywordMatches(normalizeSearchText('Curso de C# para principiantes'), 'c++')).toBe(false);
  });

  it('matches a multi-word phrase across line breaks and repeated spaces', () => {
    expect(
      keywordMatches(normalizeSearchText('Denuncian una ocupacion\n   ilegal en el barrio'), 'ocupacion ilegal'),
    ).toBe(true);
  });

  it('does not match a multi-word phrase embedded inside a longer word', () => {
    expect(
      keywordMatches(normalizeSearchText('Crece la preocupacion de vivienda en Madrid'), 'ocupacion de vivienda'),
    ).toBe(false);
    expect(
      keywordMatches(normalizeSearchText('Denuncian la ocupacion de vivienda en Madrid'), 'ocupacion de vivienda'),
    ).toBe(true);
  });

  it('normalizes accents and case on both the keyword and the haystack', () => {
    expect(keywordMatches(normalizeSearchText('DESAHUCIO en Madrid'), 'desahucio')).toBe(true);
    expect(keywordMatches(normalizeSearchText('ocupacion ilegal'), 'Ocupación')).toBe(true);
  });

  it('honours punctuation as a boundary', () => {
    expect(keywordMatches(normalizeSearchText('Hubo una ocupacion, segun fuentes'), 'ocupacion')).toBe(true);
  });

  it('never matches an empty or whitespace-only keyword', () => {
    expect(keywordMatches('cualquier texto', '')).toBe(false);
    expect(keywordMatches('cualquier texto', '   ')).toBe(false);
  });

  it('returns the same result when the same keyword is evaluated repeatedly (memoized patterns are stateless)', () => {
    const haystack = normalizeSearchText('Ocupacion ilegal de una vivienda');
    expect(keywordMatches(haystack, 'ocupacion')).toBe(true);
    expect(keywordMatches(haystack, 'ocupacion')).toBe(true);
    expect(keywordMatches(normalizeSearchText('Terapia ocupacional'), 'ocupacion')).toBe(false);
    expect(keywordMatches(haystack, 'ocupacion')).toBe(true);
  });
});

describe('entryMatchesRule', () => {
  it('uses any-of semantics for include keywords', () => {
    const rule = { includeKeywords: ['AI', 'LLM'], excludeKeywords: [] };

    expect(entryMatchesRule('An AI launch update', rule)).toBe(true);
    expect(entryMatchesRule('A new LLM benchmark', rule)).toBe(true);
    expect(entryMatchesRule('An AI powered LLM release', rule)).toBe(true);
    expect(entryMatchesRule('A quarterly earnings report', rule)).toBe(false);
  });

  it('never matches everything when include keywords are empty', () => {
    expect(entryMatchesRule('Desahucio en Madrid', { includeKeywords: [], excludeKeywords: [] })).toBe(false);
    expect(entryMatchesRule('Desahucio en Madrid', { includeKeywords: ['', '   '], excludeKeywords: [] })).toBe(false);
  });

  it('lets any exclude keyword veto the match', () => {
    expect(
      entryMatchesRule('Desahucio comercial de local', {
        includeKeywords: ['desahucio'],
        excludeKeywords: ['comercial'],
      }),
    ).toBe(false);
  });

  it('applies word boundaries to exclude keywords too', () => {
    expect(
      entryMatchesRule('Ocupacion en una zona comercializada', {
        includeKeywords: ['ocupacion'],
        excludeKeywords: ['comercial'],
      }),
    ).toBe(true);
  });

  it('agrees with ruleMatchesNormalizedText on a pre-normalized haystack', () => {
    const rule = { includeKeywords: ['ocupación'], excludeKeywords: ['turística'] };
    const text = 'Ocupación TURÍSTICA en la costa';

    expect(entryMatchesRule(text, rule)).toBe(false);
    expect(ruleMatchesNormalizedText(normalizeSearchText(text), rule)).toBe(false);
  });
});
