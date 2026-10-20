import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hnAdapter } from './hn.adapter';

describe('hnAdapter.discover', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns no items and no warnings without calling fetch for an empty niche', async () => {
    const result = await hnAdapter.discover({ niche: '   ' });

    expect(result).toEqual({ items: [], warnings: [] });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fails cleanly on a malformed/unexpected API response instead of trusting it', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ results: 'not the algolia shape at all' }),
    });

    await expect(hnAdapter.discover({ niche: 'gadget' })).rejects.toThrow();
  });

  it('fails cleanly when a hit is missing required fields', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        hits: [{ title: 'no id or date' /* objectID/created_at missing */ }],
      }),
    });

    await expect(hnAdapter.discover({ niche: 'gadget' })).rejects.toThrow();
  });

  it('throws when the HTTP response is not ok', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({}),
    });

    await expect(hnAdapter.discover({ niche: 'gadget' })).rejects.toThrow(/500/);
  });

  it('filters out hits with a null title and maps real fields through', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        hits: [
          {
            objectID: 'story-1',
            title: 'Show HN: a neat gadget',
            url: 'https://example.com/gadget',
            points: 42,
            num_comments: 7,
            created_at: '2026-01-01T00:00:00.000Z',
          },
          {
            objectID: 'story-2',
            title: null,
            url: null,
            points: null,
            num_comments: null,
            created_at: '2026-01-02T00:00:00.000Z',
          },
        ],
      }),
    });

    const result = await hnAdapter.discover({ niche: 'gadget' });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.externalId).toBe('story-1');
    expect(result.items[0]!.metrics).toEqual({ points: 42, num_comments: 7 });
    expect(result.warnings).toHaveLength(0);
  });

  // B2 regression test.
  it('omits a null metric entirely instead of coercing it to a fabricated 0', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        hits: [
          {
            objectID: 'story-1',
            title: 'Ask HN: anyone tried this gadget?',
            url: null,
            points: 12,
            num_comments: null,
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    });

    const result = await hnAdapter.discover({ niche: 'gadget' });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.metrics).toEqual({ points: 12 });
    expect(result.items[0]!.metrics).not.toHaveProperty('num_comments');
  });

  // Regression found by a live run on 2026-10-04: Algolia omits url/points/
  // num_comments entirely (not null) on some stories, and the earlier schema
  // threw on the whole response.
  it('accepts hits where url, points and num_comments are absent rather than null', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        hits: [
          { objectID: 'story-9', title: 'Ask HN: best desk?', created_at: '2026-01-01T00:00:00.000Z' },
          { objectID: 'story-10', created_at: '2026-01-01T00:00:00.000Z' },
        ],
      }),
    });

    const result = await hnAdapter.discover({ niche: 'desk' });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.url).toBe('https://news.ycombinator.com/item?id=story-9');
    expect(result.items[0]!.metrics).toEqual({});
  });

  // S3 regression test.
  it('rejects a hit whose url is not http(s) instead of trusting it as an href', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        hits: [
          {
            objectID: 'story-1',
            title: 'Suspicious story',
            url: 'javascript:alert(1)',
            points: 1,
            num_comments: 1,
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    });

    await expect(hnAdapter.discover({ niche: 'gadget' })).rejects.toThrow();
  });

  it('rejects a hit with a malformed created_at instead of trusting it as a real timestamp', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        hits: [
          {
            objectID: 'story-1',
            title: 'Gadget',
            url: null,
            points: 1,
            num_comments: 1,
            created_at: 'not-a-real-timestamp',
          },
        ],
      }),
    });

    await expect(hnAdapter.discover({ niche: 'gadget' })).rejects.toThrow();
  });
});

describe('hnAdapter.enrich', () => {
  it('emits structured, API-method metrics so HN counts as a measured source', async () => {
    const evidence = await hnAdapter.enrich({
      source: 'HACKER_NEWS',
      externalId: 'story-1',
      title: 'A neat gadget',
      url: 'https://example.com/gadget',
      observedAt: new Date('2026-01-01T00:00:00.000Z'),
      metrics: { points: 42, num_comments: 7 },
      raw: {},
    });

    expect(evidence).toEqual([
      expect.objectContaining({ method: 'API', metric: 'points', numericValue: 42 }),
      expect.objectContaining({ method: 'API', metric: 'num_comments', numericValue: 7 }),
    ]);
  });
});
