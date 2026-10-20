import type {
  DiscoverResult,
  ProductEvidence,
  ProductSource,
  RawProduct,
  SourceHealth,
} from '@/features/discovery/source.types';
import { analyzeTrendSeries } from '@/features/scoring/trend-series';
import {
  GoogleTrendsClient,
  TrendsRequestError,
  googleTrendsClient,
} from './google-trends.client';
import { buildTrendEvidence } from './trend-evidence';

/** The dashboard polls source health on every render; Google must not be hit each time. */
const HEALTH_CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * Google Trends measures a keyword you already have; it does not discover
 * candidates, so discover() returns nothing (it is not part of the
 * discovery fan-out). enrich() fetches and classifies the product's series.
 * Health is real: a live explore probe, cached for 15 minutes, DEGRADED (with
 * the reason) on throttling/endpoint changes/network failure, DOWN only on
 * an unexpected error.
 */
export function createGoogleTrendsAdapter(
  client: GoogleTrendsClient,
  now: () => number = Date.now
): ProductSource {
  let cachedHealth: { health: SourceHealth; at: number } | null = null;

  return {
    id: 'GOOGLE_TRENDS',

    async discover(): Promise<DiscoverResult> {
      return { items: [], warnings: [] };
    },

    async enrich(product: RawProduct): Promise<ProductEvidence[]> {
      const series = await client.fetchInterestOverTime(product.title);
      const lastPoint = series.points[series.points.length - 1];
      return buildTrendEvidence({
        keyword: series.keyword,
        url: series.url,
        observedAt: lastPoint?.date ?? series.fetchedAt,
        analysis: analyzeTrendSeries(series.points),
      });
    },

    async healthCheck(): Promise<SourceHealth> {
      if (cachedHealth && now() - cachedHealth.at < HEALTH_CACHE_TTL_MS) {
        return cachedHealth.health;
      }

      const checkedAt = new Date(now());
      let health: SourceHealth;
      try {
        await client.probe();
        health = { id: 'GOOGLE_TRENDS', status: 'HEALTHY', checkedAt };
      } catch (error) {
        // Every typed client error means the endpoint answered badly or not at all: degraded, with the reason.
        const degraded = error instanceof TrendsRequestError;
        health = {
          id: 'GOOGLE_TRENDS',
          status: degraded ? 'DEGRADED' : 'DOWN',
          message: error instanceof Error ? error.message : 'Unknown error',
          checkedAt,
        };
      }

      cachedHealth = { health, at: now() };
      return health;
    },
  };
}

export const googleTrendsAdapter = createGoogleTrendsAdapter(googleTrendsClient);
