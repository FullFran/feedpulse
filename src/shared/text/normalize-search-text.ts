/**
 * Canonical search-text normalizer.
 *
 * Every layer that compares free text against tenant keywords MUST go through
 * this function: rule matching in ingestion, the `normalized_search_document`
 * column written by Postgres, and the `ILIKE` filter used by the entries list
 * endpoint. Historically four slightly different implementations existed and
 * they disagreed on whitespace and casing, so a keyword could match in memory
 * and miss in SQL (or the other way round).
 *
 * The transformation is, in order:
 *  1. NFD decomposition, so `á` becomes `a` + U+0301.
 *  2. Removal of the Combining Diacritical Marks block (U+0300-U+036F), which
 *     makes matching accent-insensitive for Latin, Greek and Cyrillic alike.
 *  3. Lowercasing.
 *  4. Whitespace collapsing, so a phrase split across a line break still
 *     matches a single-spaced keyword.
 *  5. Trimming.
 *
 * Migration `0016_unify_search_normalization.sql` defines
 * `feedpulse_normalize_search_text(text)` with exactly the same steps; keep the
 * two in sync if this ever changes.
 */
export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}
