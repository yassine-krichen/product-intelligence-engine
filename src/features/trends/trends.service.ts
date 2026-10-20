import { prisma } from '@/lib/prisma';
import { recordEvidence, resolveCandidate } from '@/features/ledger/ledger.service';
import {
  analyzeTrendSeries,
  type TrendAnalysis,
  type TrendPoint,
} from '@/features/scoring/trend-series';
import { googleTrendsClient, type GoogleTrendsClient } from './google-trends.client';
import { buildTrendEvidence } from './trend-evidence';

const TREND_METRIC = 'interest_index';
const TREND_PERIOD = 'week';
/** Trends data moves slowly and the endpoint is unofficial: a day-old series is fine and keeps us from re-scraping (spec section 15). */
export const TREND_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface TrendCheckResult {
  candidateId: string;
  keyword: string;
  geo: string;
  fromCache: boolean;
  fetchedAt: string;
  expiresAt: string;
  url: string;
  pointCount: number;
  analysis: TrendAnalysis;
  evidenceRows: number;
}

export interface TrendCheckInput {
  candidate: string;
  /** Defaults to the candidate's name. */
  keyword?: string;
  geo: string;
}

interface TrendCheckDeps {
  client?: GoogleTrendsClient;
  now?: () => Date;
}

/**
 * Fetches (or reuses a cached) Google Trends series for a candidate, stores
 * it as TrendObservation rows, classifies it, and records the result as
 * evidence. A fetch failure throws; nothing is stored or invented.
 */
export async function checkTrendsForCandidate(
  input: TrendCheckInput,
  deps: TrendCheckDeps = {}
): Promise<TrendCheckResult> {
  const client = deps.client ?? googleTrendsClient;
  const now = (deps.now ?? (() => new Date()))();

  const candidate = await resolveCandidate(input.candidate);
  const keyword = input.keyword ?? candidate.name;
  const seriesKey = {
    productId: candidate.id,
    source: 'GOOGLE_TRENDS',
    keyword,
    geo: input.geo,
    metric: TREND_METRIC,
  } as const;

  const cached = await prisma.trendObservation.findMany({
    where: { ...seriesKey, expiresAt: { gt: now } },
    orderBy: { observedAt: 'asc' },
    select: { observedAt: true, value: true, fetchedAt: true, expiresAt: true, url: true },
  });

  let points: TrendPoint[];
  let fetchedAt: Date;
  let expiresAt: Date;
  let url: string;
  let fromCache = false;

  if (cached.length > 0) {
    fromCache = true;
    points = cached.map((row) => ({ date: row.observedAt, value: row.value }));
    fetchedAt = cached[0]!.fetchedAt;
    expiresAt = cached[0]!.expiresAt ?? now;
    url = cached[0]!.url ?? '';
  } else {
    const series = await client.fetchInterestOverTime(keyword, input.geo);
    points = series.points;
    fetchedAt = series.fetchedAt;
    expiresAt = new Date(fetchedAt.getTime() + TREND_CACHE_TTL_MS);
    url = series.url;

    await prisma.$transaction([
      prisma.trendObservation.deleteMany({ where: seriesKey }),
      prisma.trendObservation.createMany({
        data: points.map((point) => ({
          ...seriesKey,
          value: point.value,
          period: TREND_PERIOD,
          url,
          observedAt: point.date,
          fetchedAt,
          expiresAt,
        })),
      }),
    ]);
  }

  const analysis = analyzeTrendSeries(points);
  const lastPoint = points[points.length - 1];
  // Evidence is stamped with the newest data point's own date so re-running
  // within the same week updates the rows instead of piling up duplicates.
  const observedAt = lastPoint?.date ?? fetchedAt;
  const evidence = buildTrendEvidence({ keyword, url, observedAt, analysis });

  for (const row of evidence) {
    await recordEvidence(candidate.id, {
      source: 'GOOGLE_TRENDS',
      claim: row.claim,
      url: row.url,
      method: 'API',
      observedAt: row.observedAt,
      metric: row.metric,
      numericValue: row.numericValue,
      unit: row.unit,
      valueText: row.value,
      confidence: row.confidence,
    });
  }

  return {
    candidateId: candidate.id,
    keyword,
    geo: input.geo,
    fromCache,
    fetchedAt: fetchedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    url,
    pointCount: points.length,
    analysis,
    evidenceRows: evidence.length,
  };
}

/** No-DB variant for live verification: fetch, classify, print, store nothing. */
export async function dryRunTrends(
  keyword: string,
  geo: string,
  client: GoogleTrendsClient = googleTrendsClient
): Promise<{ keyword: string; geo: string; url: string; pointCount: number; firstPoint: string | null; lastPoint: string | null; analysis: TrendAnalysis }> {
  const series = await client.fetchInterestOverTime(keyword, geo);
  return {
    keyword: series.keyword,
    geo: series.geo,
    url: series.url,
    pointCount: series.points.length,
    firstPoint: series.points[0]?.date.toISOString() ?? null,
    lastPoint: series.points[series.points.length - 1]?.date.toISOString() ?? null,
    analysis: analyzeTrendSeries(series.points),
  };
}
