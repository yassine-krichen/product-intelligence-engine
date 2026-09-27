import { z } from 'zod';
import type {
  DiscoverResult,
  DiscoveryInput,
  ProductEvidence,
  ProductSource,
  RawProduct,
  SourceHealth,
  SourceWarning,
} from '../source.types';

/**
 * Reddit's public listing JSON (`/r/{subreddit}/hot.json`) is readable
 * without OAuth for this read-only use case — no auth bypass involved, and a
 * descriptive User-Agent identifies this project per Reddit's API rules.
 *
 * SSRF/injection guard (spec section 18): the subreddit name is validated
 * against this allowlist regex BEFORE it is ever interpolated into a URL.
 * Reddit subreddit names are 2-21 chars, alphanumeric + underscore only.
 */
const SUBREDDIT_ALLOWLIST = /^[A-Za-z0-9_]{2,21}$/;

const RedditPostSchema = z.object({
  id: z.string(),
  title: z.string(),
  // S3 fix: the URL is built by string-interpolating this field
  // (`https://www.reddit.com${permalink}`) — require it to actually be a
  // same-site relative post path before trusting it, so a compromised/
  // malicious API response can't turn this into an absolute off-site or
  // protocol-relative URL rendered as an <a href> (spec section 18).
  permalink: z.string().regex(/^\/r\//, 'permalink must start with /r/'),
  ups: z.number(),
  num_comments: z.number(),
  created_utc: z.number(),
});

const RedditListingSchema = z.object({
  data: z.object({
    children: z.array(
      z.object({
        data: RedditPostSchema,
      })
    ),
  }),
});

function userAgent(): string {
  return (
    process.env.REDDIT_USER_AGENT ??
    'product-intelligence-engine/0.1 (contact: unset)'
  );
}

/** Validates and normalizes a caller-supplied subreddit name, or returns null. */
export function isAllowedSubreddit(subreddit: string): boolean {
  return SUBREDDIT_ALLOWLIST.test(subreddit);
}

async function fetchHot(subreddit: string, limit: number): Promise<RawProduct[]> {
  if (!isAllowedSubreddit(subreddit)) {
    // Never interpolate a rejected value into the URL.
    throw new Error(`Rejected subreddit name (fails allowlist): "${subreddit}"`);
  }

  const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=${encodeURIComponent(
    String(limit)
  )}`;

  const response = await fetch(url, {
    headers: { 'User-Agent': userAgent() },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Reddit request failed: ${response.status} ${response.statusText}`);
  }

  const json: unknown = await response.json();
  const parsed = RedditListingSchema.parse(json);

  return parsed.data.children.map(
    ({ data: post }): RawProduct => ({
      source: 'REDDIT',
      externalId: post.id,
      title: post.title,
      url: `https://www.reddit.com${post.permalink}`,
      observedAt: new Date(post.created_utc * 1000),
      metrics: {
        ups: post.ups,
        num_comments: post.num_comments,
      },
      raw: post,
    })
  );
}

export const redditAdapter: ProductSource = {
  id: 'REDDIT',

  async discover(input: DiscoveryInput): Promise<DiscoverResult> {
    const subreddits = input.subreddits ?? [];
    if (subreddits.length === 0) {
      // No subreddit list supplied — Reddit's hot listing has no free-text
      // query param, so there is nothing safe to fetch. Not an error: the
      // pipeline treats an empty result as "this source contributed nothing
      // this run", not a failure.
      return { items: [], warnings: [] };
    }

    const limit = input.limit ?? 25;
    const niche = input.niche.trim().toLowerCase();

    // S6 fix: Promise.all previously meant one bad subreddit (private,
    // banned, rate-limited, network error) failed the ENTIRE Reddit source
    // for a niche hunt that may have listed several. Promise.allSettled
    // keeps every subreddit that succeeded; a failed one is surfaced as a
    // warning (spec section 14: failures must not destroy the whole research
    // run, and section 2: data gaps must be explicit) rather than aborting
    // the others or only reaching a server log the user never sees. Only if
    // every subreddit failed is this treated as a real discovery error for
    // the run — an empty result from "all requests failed" must not look
    // identical to "nothing matched".
    const settled = await Promise.allSettled(
      subreddits.map((subreddit) => fetchHot(subreddit, limit))
    );

    const posts: RawProduct[] = [];
    const subredditFailures: string[] = [];
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        posts.push(...result.value);
      } else {
        const subreddit = subreddits[index]!;
        const message = result.reason instanceof Error ? result.reason.message : 'Unknown error';
        subredditFailures.push(`r/${subreddit}: ${message}`);
        console.warn(`[redditAdapter] subreddit fetch failed, continuing with the rest`, {
          subreddit,
          message,
        });
      }
    });

    if (posts.length === 0 && subredditFailures.length > 0) {
      throw new Error(`All subreddit requests failed: ${subredditFailures.join('; ')}`);
    }

    // hot.json has no keyword filter server-side; narrow client-side by the
    // niche keyword so results stay relevant to what the user asked for.
    const items =
      niche.length === 0 ? posts : posts.filter((post) => post.title.toLowerCase().includes(niche));

    // A partial failure (some subreddits succeeded, at least one didn't) is
    // still a data gap worth recording on the run, even though it isn't
    // fatal to this discover() call — the pipeline folds these into the same
    // `ResearchRun.errors` trail as a full adapter failure (S6).
    const warnings: SourceWarning[] = subredditFailures.map((failure) => ({
      message: `Partial Reddit fetch failure: ${failure}`,
    }));

    return { items, warnings };
  },

  async enrich(product: RawProduct): Promise<ProductEvidence[]> {
    const ups = product.metrics.ups;
    const comments = product.metrics.num_comments;
    const evidence: ProductEvidence[] = [];

    if (typeof ups === 'number') {
      evidence.push({
        claim: 'Reddit post upvotes',
        value: String(ups),
        url: product.url,
        observedAt: product.observedAt,
        confidence: 0.6,
      });
    }

    if (typeof comments === 'number') {
      evidence.push({
        claim: 'Reddit post comment count',
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
      const response = await fetch('https://www.reddit.com/r/all/hot.json?limit=1', {
        headers: { 'User-Agent': userAgent() },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        return {
          id: 'REDDIT',
          status: 'DEGRADED',
          message: `HTTP ${response.status}`,
          checkedAt,
        };
      }
      return { id: 'REDDIT', status: 'HEALTHY', checkedAt };
    } catch (error) {
      return {
        id: 'REDDIT',
        status: 'DOWN',
        message: error instanceof Error ? error.message : 'Unknown error',
        checkedAt,
      };
    }
  },
};
