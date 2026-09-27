/**
 * Deterministic candidate-name normalization — no AI call in Phase 1.
 * Used purely as a dedup key so the same product mentioned on Reddit and HN
 * (or twice on the same source) collapses to one Product row.
 */

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'this',
  'that',
  'these',
  'those',
  'is',
  'are',
  'was',
  'were',
  'for',
  'of',
  'in',
  'on',
  'to',
  'with',
  'and',
  'or',
  'my',
  'your',
  'i',
  'we',
  'you',
  'it',
  'new',
  'show',
  'hn',
]);

export function normalizeTitle(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0 && !STOPWORDS.has(word));

  return words.join(' ').trim();
}
