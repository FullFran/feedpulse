import { normalizeSearchText } from '../../../shared/text/normalize-search-text';

/**
 * Canonical keyword matcher for classification rules.
 *
 * Two properties matter and the previous implementation only had one of each:
 *
 *  - **Word boundaries.** A keyword must appear as a whole word or a whole
 *    expression. `ai` must not match `said` or `certain`, and `outage` must not
 *    match `outages`. JavaScript's `\b` is ASCII-only and also breaks on
 *    keywords that end in a non-word character, so `c++`, `москва` and `αθηνα`
 *    all failed. The boundary is therefore expressed with Unicode lookarounds:
 *    the keyword may not be flanked by another letter or digit.
 *  - **Whitespace tolerance.** Both sides go through
 *    {@link normalizeSearchText}, so `power outage` still matches a headline
 *    that wraps as `power\n   outage`.
 *
 * The same rule is applied to single-word and multi-word phrases. There is no
 * `String.prototype.includes` fallback: substring matching is exactly the bug
 * this module exists to remove.
 */

/** Classification rule expressed as include/exclude keyword lists. */
export interface KeywordRule {
  includeKeywords: string[];
  excludeKeywords: string[];
}

/**
 * Compiled patterns are memoized because ingestion evaluates every active rule
 * against every inserted entry; without a cache a 200-item feed recompiles the
 * same regex hundreds of times. The key is the *normalized* phrase, so
 * `São Paulo`, `sao paulo` and `  SAO  PAULO ` share one entry.
 */
const compiledPhrasePatterns = new Map<string, RegExp | null>();

/** Bound on the memo so a tenant with a pathological rule set cannot grow it without limit. */
const MAX_COMPILED_PHRASE_PATTERNS = 5000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phrasePattern(keyword: string): RegExp | null {
  const normalizedPhrase = normalizeSearchText(keyword);
  const cached = compiledPhrasePatterns.get(normalizedPhrase);

  if (cached !== undefined) {
    return cached;
  }

  const compiled = normalizedPhrase
    ? new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(normalizedPhrase)}(?![\\p{L}\\p{N}])`, 'u')
    : null;

  if (compiledPhrasePatterns.size >= MAX_COMPILED_PHRASE_PATTERNS) {
    compiledPhrasePatterns.clear();
  }

  compiledPhrasePatterns.set(normalizedPhrase, compiled);
  return compiled;
}

/**
 * `true` when `keyword` occurs in `normalizedHaystack` as a whole word or whole
 * expression.
 *
 * The haystack MUST already be normalized with {@link normalizeSearchText}; the
 * keyword is normalized here so tenant configuration may keep accents and case.
 * An empty or whitespace-only keyword never matches.
 */
export function keywordMatches(normalizedHaystack: string, keyword: string): boolean {
  const pattern = phrasePattern(keyword);
  return pattern ? pattern.test(normalizedHaystack) : false;
}

/**
 * `true` when an already normalized haystack satisfies the rule.
 *
 * Semantics: **any** include keyword matching is enough (OR), and **any**
 * exclude keyword matching vetoes the rule. A rule with no effective include
 * keyword never matches — an empty `include_keywords` array must not turn into
 * a match-all firehose.
 *
 * Ingestion calls this variant so the haystack is normalized once per entry
 * rather than once per rule.
 */
export function ruleMatchesNormalizedText(normalizedHaystack: string, rule: KeywordRule): boolean {
  const included = rule.includeKeywords.some((keyword) => keywordMatches(normalizedHaystack, keyword));

  if (!included) {
    return false;
  }

  return !rule.excludeKeywords.some((keyword) => keywordMatches(normalizedHaystack, keyword));
}

/** Convenience wrapper that normalizes `text` before applying {@link ruleMatchesNormalizedText}. */
export function entryMatchesRule(text: string, rule: KeywordRule): boolean {
  return ruleMatchesNormalizedText(normalizeSearchText(text), rule);
}
