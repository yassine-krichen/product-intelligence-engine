import { z } from 'zod';
import type {
  DiscoverResult,
  DiscoveryInput,
  ProductEvidence,
  ProductSource,
  RawProduct,
  SourceHealth,
} from '../source.types';

/**
 * Algolia's HN Search API is public, official, and requires no auth key —
 * https://hn.algolia.com/api/v1/search. No SSRF concern here since the niche
 * keyword is sent as a query parameter value, not interpolated into a path
 * or host, but it's still Zod-validated on the way back regardless.
 */
const HN_SEARCH_URL = 'https://hn.algolia.com/api/v1/search';

/**
 * S3 fix: a bare `z.string().url()` accepts any scheme Node's URL parser
 * recognizes, including `javascript:`/`data:`/`file:` — none of which
 * belong in an `<a href>` built from scraped third-party content (spec
 * section 18). Only http/https survive.
 */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const HttpUrlSchema = z.string().refine(isHttpUrl, { message: 'must be an http(s) URL' });

const HnHitSchema = z.object({
  objectID: z.string(),
  title: z.string().nullable(),
  url: HttpUrlSchema.nullable(),
  points: z.number().nullable(),
  num_comments: z.number().nullable(),
  // Also validated as a real ISO datetime (not just any string) — Algolia
  // has always returned one in practice, but this endpoint is untrusted
  // third-party input and must never be assumed well-formed (spec section 2/18).
  created_at: z.iso.datetime(),
});

const HnResponseSchema = z.object({
  hits: z.array(HnHitSchema),
});

async function searchStories(query: string, limit: number): Promise<RawProduct[]> {
  const url = `${HN_SEARCH_URL}?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${encodeURIComponent(
    String(limit)
  )}`;

  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`HN Algolia request failed: ${response.status} ${response.statusText}`);
  }

  const json: unknown = await response.json();
  const parsed = HnResponseSchema.parse(json);

  return parsed.hits
    .filter((hit) => hit.title !== null)
    .map(
      (hit): RawProduct => ({
        source: 'HACKER_NEWS',
        externalId: hit.objectID,
        title: hit.title as string,
        url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
        observedAt: new Date(hit.created_at),
        // B2 fix: a missing/null metric is omitted entirely, never coerced
        // to 0 — a stored 0 reads as "this story really has zero points",
        // which scoring and the evidence trail would then treat as a real
        // observed value instead of "unknown" (spec section 2).
        metrics: {
          ...(typeof hit.points === 'number' ? { points: hit.points } : {}),
          ...(typeof hit.num_comments === 'number' ? { num_comments: hit.num_comments } : {}),
        },
        raw: hit,
      })
    );
}

export const hnAdapter: ProductSource = {
  id: 'HACKER_NEWS',

  async discover(input: DiscoveryInput): Promise<DiscoverResult> {
    const niche = input.niche.trim();
    if (niche.length === 0) return { items: [], warnings: [] };
    // Single request, no per-item fan-out to partially fail (unlike Reddit's
    // per-subreddit fetches) — always empty warnings.
    const items = await searchStories(niche, input.limit ?? 25);
    return { items, warnings: [] };
  },

  async enrich(product: RawProduct): Promise<ProductEvidence[]> {
    const points = product.metrics.points;
    const comments = product.metrics.num_comments;
    const evidence: ProductEvidence[] = [];

    if (typeof points === 'number') {
      evidence.push({
        claim: 'Hacker News story points',
        value: String(points),
        url: product.url,
        observedAt: product.observedAt,
        confidence: 0.6,
      });
    }

    if (typeof comments === 'number') {
      evidence.push({
        claim: 'Hacker News comment count',
        value: String(comments),
        url: product.url,
        observedAt: product.observedAt,
        confidence: 0.5,
      });
    }

    return evidence;
  },

  async healthCheck(): Promise<SourceHealth> {
    const checkedAt = new Date();
    try {
      const response = await fetch(`${HN_SEARCH_URL}?query=test&hitsPerPage=1`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        return {
          id: 'HACKER_NEWS',
          status: 'DEGRADED',
          message: `HTTP ${response.status}`,
          checkedAt,
        };
      }
      return { id: 'HACKER_NEWS', status: 'HEALTHY', checkedAt };
    } catch (error) {
      return {
        id: 'HACKER_NEWS',
        status: 'DOWN',
        message: error instanceof Error ? error.message : 'Unknown error',
        checkedAt,
      };
    }
  },
};
