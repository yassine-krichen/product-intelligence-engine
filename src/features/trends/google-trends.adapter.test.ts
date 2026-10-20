import { describe, expect, it, vi } from 'vitest';
import { analyzeTrendSeries } from '@/features/scoring/trend-series';
import { createGoogleTrendsAdapter } from './google-trends.adapter';
import {
  TrendsRateLimitedError,
  TrendsRequestError,
  type GoogleTrendsClient,
  type TrendSeries,
} from './google-trends.client';
import { buildTrendEvidence } from './trend-evidence';

function fakeClient(overrides: Partial<Record<'probe' | 'fetchInterestOverTime', unknown>>): GoogleTrendsClient {
  return {
    probe: vi.fn(async () => undefined),
    fetchInterestOverTime: vi.fn(),
    ...overrides,
  } as unknown as GoogleTrendsClient;
}

describe('google trends adapter health', () => {
  it('is HEALTHY when the live probe succeeds, and caches the result', async () => {
    const probe = vi.fn(async () => undefined);
    let clock = 0;
    const adapter = createGoogleTrendsAdapter(fakeClient({ probe }), () => clock);

    expect((await adapter.healthCheck()).status).toBe('HEALTHY');
    clock += 60_000;
    await adapter.healthCheck();
    expect(probe).toHaveBeenCalledTimes(1);

    clock += 16 * 60_000;
    await adapter.healthCheck();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('reports DEGRADED with the reason on throttling, never HEALTHY', async () => {
    const adapter = createGoogleTrendsAdapter(
      fakeClient({ probe: vi.fn(async () => Promise.reject(new TrendsRateLimitedError())) })
    );

    const health = await adapter.healthCheck();

    expect(health.status).toBe('DEGRADED');
    expect(health.message).toMatch(/429/);
  });

  it('reports DEGRADED when the endpoint shape changes', async () => {
    const adapter = createGoogleTrendsAdapter(
      fakeClient({ probe: vi.fn(async () => Promise.reject(new TrendsRequestError('unexpected response shape', null))) })
    );

    expect((await adapter.healthCheck()).status).toBe('DEGRADED');
  });

  it('reports DOWN on an unexpected error', async () => {
    const adapter = createGoogleTrendsAdapter(
      fakeClient({ probe: vi.fn(async () => Promise.reject(new Error('boom'))) })
    );

    expect((await adapter.healthCheck()).status).toBe('DOWN');
  });
});

describe('google trends adapter discover/enrich', () => {
  it('does not discover candidates', async () => {
    const adapter = createGoogleTrendsAdapter(fakeClient({}));

    expect(await adapter.discover({ niche: 'pets' })).toEqual({ items: [], warnings: [] });
  });

  it('propagates a fetch failure from enrich instead of returning invented evidence', async () => {
    const adapter = createGoogleTrendsAdapter(
      fakeClient({ fetchInterestOverTime: vi.fn(async () => Promise.reject(new TrendsRateLimitedError())) })
    );

    await expect(
      adapter.enrich({
        source: 'GOOGLE_TRENDS',
        externalId: 'x',
        title: 'led dog collar',
        url: 'https://example.com',
        observedAt: new Date(),
        metrics: {},
        raw: {},
      })
    ).rejects.toBeInstanceOf(TrendsRateLimitedError);
  });

  it('turns a thin series into a single UNKNOWN classification row with no numbers', async () => {
    const series: TrendSeries = {
      keyword: 'led dog collar',
      geo: '',
      url: 'https://trends.google.com/trends/explore?q=led+dog+collar',
      fetchedAt: new Date('2026-10-04T00:00:00Z'),
      points: [{ date: new Date('2026-09-27T00:00:00Z'), value: 50 }],
    };
    const adapter = createGoogleTrendsAdapter(fakeClient({ fetchInterestOverTime: vi.fn(async () => series) }));

    const evidence = await adapter.enrich({
      source: 'GOOGLE_TRENDS',
      externalId: 'x',
      title: 'led dog collar',
      url: 'https://example.com',
      observedAt: new Date(),
      metrics: {},
      raw: {},
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.value).toMatch(/^UNKNOWN:/);
    expect(evidence[0]!.numericValue).toBeUndefined();
  });
});

describe('buildTrendEvidence', () => {
  const base = { keyword: 'x', url: 'https://trends.google.com/trends/explore?q=x', observedAt: new Date('2026-09-27T00:00:00Z') };

  it('emits numeric rows only when the numbers are meaningful', () => {
    const tinyBase = buildTrendEvidence({
      ...base,
      analysis: {
        classification: 'EMERGING',
        reason: 'r',
        flags: ['TINY_BASE'],
        recentMean: 30,
        priorYearMean: 2,
        yoyChangePercent: null,
      },
    });
    expect(tinyBase.map((row) => row.metric)).toEqual([undefined, 'interest_last_90d_mean']);

    const full = buildTrendEvidence({
      ...base,
      analysis: { classification: 'EMERGING', reason: 'r', flags: [], recentMean: 60, priorYearMean: 30, yoyChangePercent: 100 },
    });
    expect(full.map((row) => row.metric)).toEqual([undefined, 'interest_last_90d_mean', 'interest_yoy_change_pct']);
    expect(full.every((row) => row.method === 'API' && row.url === base.url)).toBe(true);
    expect(full[2]).toMatchObject({ numericValue: 100, unit: '%' });
  });

  it('keeps analyzeTrendSeries output on thin data free of numeric rows', () => {
    const rows = buildTrendEvidence({ ...base, analysis: analyzeTrendSeries([]) });

    expect(rows).toHaveLength(1);
  });
});
