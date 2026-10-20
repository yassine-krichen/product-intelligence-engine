import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoogleTrendsClient, TrendSeries } from './google-trends.client';

const prismaMock = vi.hoisted(() => ({
  product: { findUnique: vi.fn() },
  trendObservation: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
  researchEvidence: { upsert: vi.fn() },
  $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
}));
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

const { checkTrendsForCandidate, TREND_CACHE_TTL_MS } = await import('./trends.service');

const NOW = new Date('2026-10-04T12:00:00Z');
const candidateRow = { id: 'p1', canonicalName: 'Pickleball Paddle', niche: 'sports', description: null };
const WEEK_MS = 7 * 86_400_000;

function series(weeks: number): TrendSeries {
  const points = Array.from({ length: weeks }, (_, i) => ({
    date: new Date(Date.UTC(2026, 8, 27) - (weeks - 1 - i) * WEEK_MS),
    value: 40 + Math.sin(i * 12.9898) * 1.5,
  }));
  return { keyword: 'Pickleball Paddle', geo: '', points, fetchedAt: NOW, url: 'https://trends.google.com/trends/explore?q=x' };
}

function fakeClient(fetchInterestOverTime: unknown): GoogleTrendsClient {
  return { fetchInterestOverTime } as unknown as GoogleTrendsClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.product.findUnique.mockResolvedValue(candidateRow);
  prismaMock.researchEvidence.upsert.mockResolvedValue({ id: 'e' });
  prismaMock.trendObservation.findMany.mockResolvedValue([]);
  prismaMock.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
});

describe('checkTrendsForCandidate', () => {
  it('fetches on a cache miss, stores observations with fetchedAt/expiresAt, and records evidence', async () => {
    const fetchSeries = vi.fn(async () => series(260));

    const result = await checkTrendsForCandidate(
      { candidate: 'p1', geo: '' },
      { client: fakeClient(fetchSeries), now: () => NOW }
    );

    expect(result.fromCache).toBe(false);
    expect(fetchSeries).toHaveBeenCalledWith('Pickleball Paddle', '');
    const createManyArg = prismaMock.trendObservation.createMany.mock.calls[0]![0] as {
      data: Array<{ fetchedAt: Date; expiresAt: Date; source: string; url: string }>;
    };
    expect(createManyArg.data).toHaveLength(260);
    expect(createManyArg.data[0]).toMatchObject({ source: 'GOOGLE_TRENDS' });
    expect(createManyArg.data[0]!.expiresAt.getTime() - createManyArg.data[0]!.fetchedAt.getTime()).toBe(TREND_CACHE_TTL_MS);
    expect(result.evidenceRows).toBe(prismaMock.researchEvidence.upsert.mock.calls.length);
    expect(prismaMock.researchEvidence.upsert.mock.calls[0]![0]).toMatchObject({
      create: { source: 'GOOGLE_TRENDS', method: 'API' },
    });
  });

  it('serves a fresh cached series without calling Google again', async () => {
    const cached = series(260).points.map((point) => ({
      observedAt: point.date,
      value: point.value,
      fetchedAt: new Date('2026-10-04T06:00:00Z'),
      expiresAt: new Date('2026-10-05T06:00:00Z'),
      url: 'https://trends.google.com/trends/explore?q=x',
    }));
    prismaMock.trendObservation.findMany.mockResolvedValue(cached);
    const fetchSeries = vi.fn();

    const result = await checkTrendsForCandidate(
      { candidate: 'p1', geo: '' },
      { client: fakeClient(fetchSeries), now: () => NOW }
    );

    expect(result.fromCache).toBe(true);
    expect(fetchSeries).not.toHaveBeenCalled();
    expect(prismaMock.trendObservation.createMany).not.toHaveBeenCalled();
    expect(prismaMock.trendObservation.findMany.mock.calls[0]![0]).toMatchObject({
      where: { expiresAt: { gt: NOW } },
    });
  });

  it('stores nothing and invents nothing when the fetch fails', async () => {
    const fetchSeries = vi.fn(async () => {
      throw new Error('Google Trends rate-limited this client (HTTP 429). Retry later.');
    });

    await expect(
      checkTrendsForCandidate({ candidate: 'p1', geo: '' }, { client: fakeClient(fetchSeries), now: () => NOW })
    ).rejects.toThrow(/429/);

    expect(prismaMock.trendObservation.createMany).not.toHaveBeenCalled();
    expect(prismaMock.researchEvidence.upsert).not.toHaveBeenCalled();
  });

  it('records an UNKNOWN classification and no numeric evidence for a thin series', async () => {
    const fetchSeries = vi.fn(async () => series(8));

    const result = await checkTrendsForCandidate(
      { candidate: 'p1', geo: '' },
      { client: fakeClient(fetchSeries), now: () => NOW }
    );

    expect(result.analysis.classification).toBe('UNKNOWN');
    expect(result.evidenceRows).toBe(1);
  });

  it('uses --keyword instead of the candidate name when given', async () => {
    const fetchSeries = vi.fn(async () => series(8));

    await checkTrendsForCandidate(
      { candidate: 'p1', keyword: 'pickleball', geo: 'US' },
      { client: fakeClient(fetchSeries), now: () => NOW }
    );

    expect(fetchSeries).toHaveBeenCalledWith('pickleball', 'US');
  });
});
