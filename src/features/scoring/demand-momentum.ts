import { ScoreResultSchema } from './scoring.types';
import type { ScoreResult } from './scoring.types';

export interface DemandPoint {
  value: number;
  observedAt: Date;
}

/**
 * Demand Momentum: the only dimension with a real Phase 1 calculation
 * (spec: "Implement Demand Momentum for real"; the other 4 dimensions stay
 * INSUFFICIENT_DATA until Phase 2/3).
 *
 * `points` must already be a single (source, sourceItemId, metric) series —
 * e.g. one Reddit post's `ups` observed at 2+ different fetch times. This
 * function has no way to tell "ups vs num_comments" or "post A vs post B"
 * apart from raw numbers, so that grouping is the caller's responsibility
 * (see score-dimensions.ts) — never feed it a mixed bag of metrics.
 *
 * Score = 50 + clamp(pctChange, -1, 1) * 50:
 *   50  = engagement flat since the earliest observation
 *   100 = engagement at least doubled
 *   0   = engagement collapsed to (near) zero
 * The clamp exists so one viral outlier can't push the result past what a
 * bounded 0-100 scale can represent.
 *
 * Requires >= 2 observations. A single snapshot is a moment, not a trend —
 * with fewer than 2 points this returns INSUFFICIENT_DATA with a reason
 * instead of inventing a momentum figure (spec section 2).
 */
export function computeDemandMomentum(points: DemandPoint[]): ScoreResult {
  if (points.length < 2) {
    return ScoreResultSchema.parse({
      status: 'INSUFFICIENT_DATA',
      score: null,
      reason: `Only ${points.length} demand observation(s) recorded; at least 2 are needed to measure momentum.`,
    });
  }

  const sorted = [...points].sort(
    (a, b) => a.observedAt.getTime() - b.observedAt.getTime()
  );
  const earliest = sorted[0]!.value;
  const latest = sorted[sorted.length - 1]!.value;

  // B3 fix: a baseline this small makes percent change meaningless noise
  // rather than signal — an integer engagement count going 0 -> 1 reads as
  // "infinite" growth, and 1 -> 3 reads as "+200%", neither of which is a
  // real trend. 5 is a small, defensible floor for integer social-engagement
  // counts (upvotes/points/comments): below it, a single extra vote/comment
  // swings the percentage by double digits, so the number can't be trusted
  // as a momentum signal. Report INSUFFICIENT_DATA instead of a
  // misleadingly confident score computed against near-zero (spec section 2).
  const MIN_MEANINGFUL_BASELINE = 5;
  if (earliest < MIN_MEANINGFUL_BASELINE) {
    return ScoreResultSchema.parse({
      status: 'INSUFFICIENT_DATA',
      score: null,
      reason: `Baseline value (${earliest}) is too small to measure a meaningful percent change; at least ${MIN_MEANINGFUL_BASELINE} is required.`,
    });
  }

  const percentChange = (latest - earliest) / earliest;
  const clamped = Math.max(-1, Math.min(1, percentChange));
  const rawScore = Math.round(50 + clamped * 50);
  const score = Math.max(0, Math.min(100, rawScore));

  return ScoreResultSchema.parse({
    status: 'COMPUTED',
    score,
    reason: null,
  });
}
