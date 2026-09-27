import { prisma } from '@/lib/prisma';
import { computeDemandMomentum, type DemandPoint } from './demand-momentum';
import { ScoreResultSchema } from './scoring.types';
import type { ScoreDimensionValue, ScoreResult } from './scoring.types';

const NOT_YET_IMPLEMENTED_REASON = 'Not yet implemented (Phase 2/3).';

/** A single stored DemandObservation row, as read back from Prisma. */
interface TrackedMetricObservation {
  source: string;
  sourceItemId: string;
  metric: string;
  value: number;
  observedAt: Date;
}

/** At least this many observations of the SAME (source, sourceItemId, metric) at different fetch times are required before momentum means anything (spec section 2). */
const MIN_OBSERVATIONS_PER_TRACKED_METRIC = 2;

/**
 * Groups raw DemandObservation rows by (source, sourceItemId, metric) — the
 * only axis momentum may ever be computed along (B1 fix). Never group by
 * productId alone: a product can have many source items (several Reddit
 * posts, an HN story) each reporting several distinct metrics, and comparing
 * `ups` against `num_comments`, or one post's series against a different
 * post's series, produces a fabricated trend from data that was never a
 * time series in the first place.
 */
function groupByTrackedMetric(
  observations: TrackedMetricObservation[]
): Map<string, TrackedMetricObservation[]> {
  const groups = new Map<string, TrackedMetricObservation[]>();
  for (const observation of observations) {
    const key = `${observation.source}::${observation.sourceItemId}::${observation.metric}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(observation);
    } else {
      groups.set(key, [observation]);
    }
  }
  return groups;
}

/**
 * Computes Demand Momentum across every tracked metric a product has, never
 * mixing incomparable series (B1 fix). Each (source, sourceItemId, metric)
 * group needs its own >= 2 observations at genuinely different fetch times
 * before it contributes anything; a group built from a single research run
 * (one fetch, all metrics stamped with the same `observedAt`) has exactly 1
 * observation per metric and is correctly excluded.
 *
 * Phase 1 has no re-observation scheduler, so in practice every group will
 * almost always have exactly 1 observation and the whole dimension will
 * report INSUFFICIENT_DATA — that is the correct, intentional behavior
 * until a product has been re-observed across separate research runs, not a
 * bug to "fix" by relaxing the threshold (see README).
 */
export function computeDemandMomentumForProduct(
  observations: TrackedMetricObservation[]
): ScoreResult {
  if (observations.length === 0) {
    return ScoreResultSchema.parse({
      status: 'INSUFFICIENT_DATA',
      score: null,
      reason: 'No demand observations recorded yet.',
    });
  }

  const groups = groupByTrackedMetric(observations);
  const computedResults: Extract<ScoreResult, { status: 'COMPUTED' }>[] = [];

  for (const group of groups.values()) {
    const distinctFetchTimes = new Set(group.map((o) => o.observedAt.getTime()));
    if (
      group.length < MIN_OBSERVATIONS_PER_TRACKED_METRIC ||
      distinctFetchTimes.size < MIN_OBSERVATIONS_PER_TRACKED_METRIC
    ) {
      continue;
    }

    const points: DemandPoint[] = group.map((o) => ({
      value: o.value,
      observedAt: o.observedAt,
    }));
    const result = computeDemandMomentum(points);
    if (result.status === 'COMPUTED') {
      computedResults.push(result);
    }
  }

  if (computedResults.length === 0) {
    return ScoreResultSchema.parse({
      status: 'INSUFFICIENT_DATA',
      score: null,
      reason:
        `${groups.size} metric(s)/item(s) tracked, but none has been observed at ` +
        `${MIN_OBSERVATIONS_PER_TRACKED_METRIC}+ different fetch times yet. Demand Momentum ` +
        'requires the same item observed at 2+ different times; Phase 1 has no scheduler yet, ' +
        'so this stays INSUFFICIENT_DATA until a product has been re-observed across separate ' +
        'research runs.',
    });
  }

  // Multiple independently-qualifying metrics/items is not expected in
  // Phase 1 (see above), but if it happens, a simple average keeps the
  // result traceable (spec section 6) rather than picking one arbitrarily.
  const averageScore = Math.round(
    computedResults.reduce((sum, r) => sum + r.score, 0) / computedResults.length
  );

  return ScoreResultSchema.parse({
    status: 'COMPUTED',
    score: averageScore,
    reason:
      computedResults.length > 1
        ? `Averaged momentum across ${computedResults.length} independently tracked metrics/items.`
        : null,
  });
}

/**
 * Every dimension besides Demand Momentum has no real data source wired up
 * yet. They're written as explicit INSUFFICIENT_DATA rows — never omitted —
 * so the 5-dimension shape exists end-to-end in the UI from day one, and a
 * product page never implies "0" or "unknown-but-hidden" for something
 * that's simply not built.
 */
const PLACEHOLDER_DIMENSIONS: ScoreDimensionValue[] = [
  'ECONOMICS',
  'COMPETITION',
  'SUPPLIER_QUALITY',
  'PRODUCT_SUITABILITY',
];

async function upsertDimension(
  productId: string,
  dimension: ScoreDimensionValue,
  result: ScoreResult
): Promise<void> {
  await prisma.productScoreDimension.upsert({
    where: { productId_dimension: { productId, dimension } },
    update: {
      score: result.score,
      status: result.status,
      reason: result.reason ?? null,
      computedAt: new Date(),
    },
    create: {
      productId,
      dimension,
      score: result.score,
      status: result.status,
      reason: result.reason ?? null,
    },
  });
}

/**
 * Recomputes all 5 score dimensions for a product from its currently stored
 * observations and writes them as separate ProductScoreDimension rows —
 * never a single combined score (spec section 6).
 */
export async function computeScoresForProduct(productId: string): Promise<void> {
  const demandObservations = await prisma.demandObservation.findMany({
    where: { productId },
    orderBy: { observedAt: 'asc' },
  });

  const demandResult = computeDemandMomentumForProduct(
    demandObservations.map((observation) => ({
      source: observation.source,
      sourceItemId: observation.sourceItemId,
      metric: observation.metric,
      value: observation.value,
      observedAt: observation.observedAt,
    }))
  );
  await upsertDimension(productId, 'DEMAND_MOMENTUM', demandResult);

  for (const dimension of PLACEHOLDER_DIMENSIONS) {
    await upsertDimension(productId, dimension, {
      status: 'INSUFFICIENT_DATA',
      score: null,
      reason: NOT_YET_IMPLEMENTED_REASON,
    });
  }
}
