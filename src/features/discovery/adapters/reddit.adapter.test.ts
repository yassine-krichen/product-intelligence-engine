import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAllowedSubreddit, redditAdapter } from './reddit.adapter';

describe('isAllowedSubreddit (SSRF guard)', () => {
  it('accepts well-formed subreddit names', () => {
    expect(isAllowedSubreddit('petaccessories')).toBe(true);
    expect(isAllowedSubreddit('Pet_Accessories')).toBe(true);
    expect(isAllowedSubreddit('a1')).toBe(true);
  });

  it('rejects names with path/URL characters that could redirect the fetch', () => {
    expect(isAllowedSubreddit('all/../../admin')).toBe(false);
    expect(isAllowedSubreddit('all?foo=bar')).toBe(false);
    expect(isAllowedSubreddit('all#frag')).toBe(false);
    expect(isAllowedSubreddit('evil.com')).toBe(false);
  });

  it('rejects an absolute URL passed as a "subreddit" (SSRF attempt)', () => {
    expect(isAllowedSubreddit('https://internal.service/admin')).toBe(false);
  });

  it('rejects empty string, whitespace, and out-of-range lengths', () => {
    expect(isAllowedSubreddit('')).toBe(false);
    expect(isAllowedSubreddit(' ')).toBe(false);
    expect(isAllowedSubreddit('a')).toBe(false); // below 2-char minimum
    expect(isAllowedSubreddit('a'.repeat(22))).toBe(false); // above 21-char max
  });
});

describe('redditAdapter.discover', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('rejects a malformed subreddit name BEFORE calling fetch', async () => {
    await expect(
      redditAdapter.discover({ niche: 'pets', subreddits: ['../admin'] })
    ).rejects.toThrow(/Rejected subreddit name/);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects an SSRF-style absolute-URL "subreddit" before calling fetch', async () => {
    await expect(
      redditAdapter.discover({
        niche: 'pets',
        subreddits: ['http://169.254.169.254/latest/meta-data'],
      })
    ).rejects.toThrow(/Rejected subreddit name/);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns no items and no warnings without calling fetch when no subreddits are supplied', async () => {
    const result = await redditAdapter.discover({ niche: 'pets' });

    expect(result).toEqual({ items: [], warnings: [] });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fails cleanly on a malformed/unexpected API response instead of trusting it', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ unexpected: 'shape', not: 'a reddit listing' }),
    });

    await expect(
      redditAdapter.discover({ niche: 'pets', subreddits: ['petaccessories'] })
    ).rejects.toThrow();
  });

  it('fails cleanly when the API returns posts missing required fields', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          children: [
            {
              data: {
                id: 'abc123',
                title: 'Cool gadget',
                permalink: '/r/petaccessories/comments/abc123/cool_gadget/',
                // ups / num_comments / created_utc deliberately missing —
                // a real Reddit response always has these; a stubbed/hijacked
                // one might not.
              },
            },
          ],
        },
      }),
    });

    await expect(
      redditAdapter.discover({ niche: 'pets', subreddits: ['petaccessories'] })
    ).rejects.toThrow();
  });

  it('parses a well-formed response and filters by niche keyword', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          children: [
            {
              data: {
                id: 'p1',
                title: 'Best pet collar for hiking',
                permalink: '/r/petaccessories/comments/p1/best_pet_collar/',
                ups: 120,
                num_comments: 8,
                created_utc: 1_700_000_000,
              },
            },
            {
              data: {
                id: 'p2',
                title: 'Totally unrelated laptop review',
                permalink: '/r/petaccessories/comments/p2/laptop/',
                ups: 5,
                num_comments: 1,
                created_utc: 1_700_000_100,
              },
            },
          ],
        },
      }),
    });

    const result = await redditAdapter.discover({
      niche: 'pet',
      subreddits: ['petaccessories'],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.externalId).toBe('p1');
    expect(result.items[0]!.metrics).toEqual({ ups: 120, num_comments: 8 });
    expect(result.warnings).toHaveLength(0);
  });

  // S3 regression test.
  it('fails cleanly when a post permalink does not start with /r/ instead of trusting it to build a URL', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          children: [
            {
              data: {
                id: 'p1',
                title: 'Suspicious post',
                permalink: '//evil.com/phishing',
                ups: 10,
                num_comments: 1,
                created_utc: 1_700_000_000,
              },
            },
          ],
        },
      }),
    });

    await expect(
      redditAdapter.discover({ niche: 'pets', subreddits: ['petaccessories'] })
    ).rejects.toThrow();
  });

  // S6 regression test.
  it('keeps results from subreddits that succeed when another subreddit fails, instead of failing the whole source', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.includes('/r/banned/')) {
        return { ok: false, status: 403, statusText: 'Forbidden', json: async () => ({}) };
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            children: [
              {
                data: {
                  id: 'p1',
                  title: 'Healthy subreddit post',
                  permalink: '/r/petaccessories/comments/p1/post/',
                  ups: 10,
                  num_comments: 1,
                  created_utc: 1_700_000_000,
                },
              },
            ],
          },
        }),
      };
    });

    const result = await redditAdapter.discover({
      niche: '',
      subreddits: ['banned', 'petaccessories'],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.externalId).toBe('p1');
  });

  // S6 regression test: a partial per-subreddit failure must not be lost —
  // it has to be surfaced as a warning the pipeline can fold into the run's
  // recorded errors, not just reach a console.warn no one downstream sees.
  it('surfaces a partial subreddit failure as a warning instead of only logging it', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.includes('/r/banned/')) {
        return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
      }
      return {
        ok: true,
        json: async () => ({
          data: {
            children: [
              {
                data: {
                  id: 'p1',
                  title: 'Healthy subreddit post',
                  permalink: '/r/petaccessories/comments/p1/post/',
                  ups: 10,
                  num_comments: 1,
                  created_utc: 1_700_000_000,
                },
              },
            ],
          },
        }),
      };
    });

    const result = await redditAdapter.discover({
      niche: '',
      subreddits: ['banned', 'petaccessories'],
    });

    expect(result.items).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.message).toMatch(/r\/banned/);
    expect(result.warnings[0]!.message).toMatch(/404/);
  });

  it('throws when every subreddit fails, instead of silently returning an empty list', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({}),
    });

    await expect(
      redditAdapter.discover({ niche: 'pets', subreddits: ['banned1', 'banned2'] })
    ).rejects.toThrow(/All subreddit requests failed/);
  });
});
