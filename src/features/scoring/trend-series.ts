export interface TrendPoint {
  date: Date;
  value: number;
}

export type TrendClassification =
  | 'EMERGING'
  | 'ACCELERATING'
  | 'PEAK'
  | 'DECLINING'
  | 'SEASONAL'
  | 'FAD'
  | 'EVERGREEN'
  | 'UNKNOWN';

export type TrendFlag =
  | 'TINY_BASE'
  | 'ONE_WEEK_SPIKE'
  | 'SEASONALITY_NOT_TESTED'
  | 'SEASONAL_COMPONENT';

export interface TrendAnalysis {
  classification: TrendClassification;
  reason: string;
  flags: TrendFlag[];
  /** Mean of the last 90 days (one-week spikes smoothed out); null when it could not be computed. */
  recentMean: number | null;
  /** Mean of the same 90-day window one year earlier. */
  priorYearMean: number | null;
  /** (recent / priorYear - 1) * 100; null on thin data or a tiny base, where the percentage is not meaningful. */
  yoyChangePercent: number | null;
}

const DAY_MS = 86_400_000;

/** Under ~6 months of weekly points any label is noise. */
const MIN_POINTS = 26;
/** 90-day recent window plus a 365-day lookback: without a year-ago window we cannot control for seasonality. */
const MIN_SPAN_FOR_YEAR_OVER_YEAR_DAYS = 455;
/** Two full years (minus two weeks slack) are needed to see a pattern repeat. */
const MIN_SPAN_FOR_SEASONAL_DAYS = 716;
/** Recent-vs-year-ago window length: long enough to smooth weekly noise, short enough to react. */
const RECENT_WINDOW_DAYS = 90;
const LAST_MONTH_DAYS = 30;
/** A window with fewer points than this is gaps, not data. */
const MIN_POINTS_PER_WINDOW = 4;
/** Same idea as MIN_MEANINGFUL_BASELINE in demand-momentum.ts: on Google's 0-100 index, a mean below 5 makes percent change noise. */
const MIN_MEANINGFUL_LEVEL = 5;
/** +50% year over year is clearly beyond normal week-to-week drift. */
const GROWTH_RATIO = 1.5;
/** -33% year over year, the mirror of the growth bar. */
const DECLINE_RATIO = 0.67;
/** A point this many times the window median is a spike, not a level shift. */
const SPIKE_MULTIPLE = 3;
/** Anything lasting longer than a week is a real move, not a one-week blip. */
const SPIKE_MAX_DAYS = 7;
/** A burst shorter than 8 weeks that has fully decayed is a fad, not a trend. */
const FAD_MAX_ELEVATED_DAYS = 56;
const FAD_ELEVATED_FRACTION_OF_PEAK = 0.5;
/** "Back to baseline" means under a quarter of the burst's peak. */
const FAD_RESIDUAL_FRACTION_OF_PEAK = 0.25;
/** Growth still speeding up: last month 15% above the 90-day mean and the 90 days 30% above the 90 days before. */
const ACCELERATION_LAST_MONTH_RATIO = 1.15;
const ACCELERATION_PREVIOUS_WINDOW_RATIO = 1.3;
/** Near an all-time high and no longer rising faster than the 90-day mean: possible peak. */
const PEAK_PROXIMITY = 0.85;
const PEAK_FLATTENING_RATIO = 1.05;
/** A repeating shape must correlate this well year over year to count as seasonal. */
const SEASONAL_MIN_CORRELATION = 0.6;
/** Detrended swing must be >= 25% of the level, otherwise ordinary growth curvature would look seasonal. */
const SEASONAL_MIN_AMPLITUDE = 0.25;
/** Half a year of weekly bins must overlap before two years are comparable. */
const SEASONAL_MIN_COMMON_BINS = 26;
const SEASONAL_BIN_DAYS = 7;
/** Yearly mean within 40% of the overall mean counts as a stable level across years. */
const EVERGREEN_MAX_YEARLY_DEVIATION = 0.4;

function unknown(reason: string, flags: TrendFlag[] = []): TrendAnalysis {
  return {
    classification: 'UNKNOWN',
    reason,
    flags,
    recentMean: null,
    priorYearMean: null,
    yoyChangePercent: null,
  };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function inWindow(points: TrendPoint[], fromExclusive: number, toInclusive: number): TrendPoint[] {
  return points.filter((point) => {
    const time = point.date.getTime();
    return time > fromExclusive && time <= toInclusive;
  });
}

function pearson(a: number[], b: number[]): number {
  const meanA = mean(a);
  const meanB = mean(b);
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i]! - meanA;
    const db = b[i]! - meanB;
    covariance += da * db;
    varianceA += da * da;
    varianceB += db * db;
  }
  if (varianceA === 0 || varianceB === 0) return 0;
  return covariance / Math.sqrt(varianceA * varianceB);
}

/** Residuals of a least-squares line through (index, value); removes within-year growth so ramps do not read as seasonality. */
function detrend(entries: Array<[number, number]>): Map<number, number> {
  const xs = entries.map(([x]) => x);
  const ys = entries.map(([, y]) => y);
  const meanX = mean(xs);
  const meanY = mean(ys);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < xs.length; i++) {
    numerator += (xs[i]! - meanX) * (ys[i]! - meanY);
    denominator += (xs[i]! - meanX) ** 2;
  }
  const slope = denominator === 0 ? 0 : numerator / denominator;
  const residuals = new Map<number, number>();
  for (let i = 0; i < xs.length; i++) {
    residuals.set(xs[i]!, ys[i]! - (meanY + slope * (xs[i]! - meanX)));
  }
  return residuals;
}

interface YearBlock {
  mean: number;
  /** week-of-block -> detrended value */
  residuals: Map<number, number>;
  amplitude: number;
}

/** Splits the series into consecutive 365-day blocks ending at `last`, newest first; only fully covered blocks are returned. */
function buildYearBlocks(points: TrendPoint[], last: number): YearBlock[] {
  const first = points[0]!.date.getTime();
  const blocks: YearBlock[] = [];
  for (let k = 0; ; k++) {
    const end = last - k * 365 * DAY_MS;
    const start = end - 365 * DAY_MS;
    if (first > start + 14 * DAY_MS) break;

    const byBin = new Map<number, number[]>();
    for (const point of inWindow(points, start, end)) {
      const bin = Math.min(
        51,
        Math.floor((point.date.getTime() - start) / (SEASONAL_BIN_DAYS * DAY_MS))
      );
      byBin.set(bin, [...(byBin.get(bin) ?? []), point.value]);
    }
    const binMeans: Array<[number, number]> = [...byBin].map(([bin, values]) => [bin, mean(values)]);
    if (binMeans.length < SEASONAL_MIN_COMMON_BINS) break;

    const residuals = detrend(binMeans);
    const blockMean = mean(binMeans.map(([, value]) => value));
    const residualStd = Math.sqrt(mean([...residuals.values()].map((r) => r * r)));
    blocks.push({
      mean: blockMean,
      residuals,
      amplitude: blockMean > 0 ? residualStd / blockMean : 0,
    });
  }
  return blocks;
}

function isSeasonal(blocks: YearBlock[]): boolean {
  if (blocks.length < 2) return false;
  if (blocks.some((block) => block.mean < MIN_MEANINGFUL_LEVEL)) return false;
  if (blocks.some((block) => block.amplitude < SEASONAL_MIN_AMPLITUDE)) return false;

  for (let i = 0; i + 1 < blocks.length; i++) {
    const a: number[] = [];
    const b: number[] = [];
    for (const [bin, value] of blocks[i]!.residuals) {
      const other = blocks[i + 1]!.residuals.get(bin);
      if (other !== undefined) {
        a.push(value);
        b.push(other);
      }
    }
    if (a.length < SEASONAL_MIN_COMMON_BINS || pearson(a, b) < SEASONAL_MIN_CORRELATION) {
      return false;
    }
  }
  return true;
}

function medianSpacingDays(points: TrendPoint[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < points.length; i++) {
    gaps.push((points[i]!.date.getTime() - points[i - 1]!.date.getTime()) / DAY_MS);
  }
  return Math.max(median(gaps), 1);
}

/** Replaces isolated spike points in the recent window by the window median so one viral week cannot fake a trend. */
function smoothRecentSpikes(
  points: TrendPoint[],
  recentStart: number,
  last: number
): { points: TrendPoint[]; spiked: boolean } {
  const recent = inWindow(points, recentStart, last);
  const windowMedian = median(recent.map((point) => point.value));
  const threshold = SPIKE_MULTIPLE * Math.max(windowMedian, MIN_MEANINGFUL_LEVEL);
  const hot = recent.filter((point) => point.value >= threshold);
  const maxSpikePoints = Math.max(1, Math.round(SPIKE_MAX_DAYS / medianSpacingDays(points)));

  if (hot.length === 0 || hot.length > maxSpikePoints) return { points, spiked: false };

  const hotSet = new Set(hot);
  return {
    points: points.map((point) =>
      hotSet.has(point) ? { date: point.date, value: windowMedian } : point
    ),
    spiked: true,
  };
}

/** A single short burst, long over, back near baseline. */
function isDecayedBurst(points: TrendPoint[], recentStart: number, recentMean: number): boolean {
  const peak = Math.max(...points.map((point) => point.value));
  if (peak < MIN_MEANINGFUL_LEVEL) return false;

  const elevatedTimes = points
    .filter((point) => point.value >= FAD_ELEVATED_FRACTION_OF_PEAK * peak)
    .map((point) => point.date.getTime());
  const elevatedSpanDays = (Math.max(...elevatedTimes) - Math.min(...elevatedTimes)) / DAY_MS;
  const peakPoint = points.find((point) => point.value === peak)!;

  return (
    elevatedSpanDays <= FAD_MAX_ELEVATED_DAYS &&
    peakPoint.date.getTime() <= recentStart &&
    recentMean <= FAD_RESIDUAL_FRACTION_OF_PEAK * peak
  );
}

function maxRollingMean(points: TrendPoint[]): number {
  let best = 0;
  for (const point of points) {
    const time = point.date.getTime();
    const window = inWindow(points, time - RECENT_WINDOW_DAYS * DAY_MS, time);
    if (window.length >= MIN_POINTS_PER_WINDOW) {
      best = Math.max(best, mean(window.map((p) => p.value)));
    }
  }
  return best;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Classifies a demand/interest time series conservatively. Every guard exists
 * to prevent a confident-looking false positive: thin history, a seasonal
 * pattern, a one-week spike, or growth measured from a near-zero base all end
 * in UNKNOWN or an explicitly flagged label, never a clean "EMERGING".
 *
 * The recent 90 days are compared with the same 90 days one year earlier, not
 * with the preceding 90 days, so a seasonal ramp does not read as growth.
 */
export function analyzeTrendSeries(input: TrendPoint[]): TrendAnalysis {
  const valid = input.filter(
    (point) => !Number.isNaN(point.date.getTime()) && Number.isFinite(point.value)
  );
  if (valid.length !== input.length) {
    return unknown(
      `Series contains ${input.length - valid.length} invalid point(s); refusing to classify.`
    );
  }
  if (valid.length < MIN_POINTS) {
    return unknown(
      `Only ${valid.length} data point(s); at least ${MIN_POINTS} are needed to classify a trend.`
    );
  }

  const sorted = [...valid].sort((a, b) => a.date.getTime() - b.date.getTime());
  const last = sorted[sorted.length - 1]!.date.getTime();
  const spanDays = (last - sorted[0]!.date.getTime()) / DAY_MS;

  if (spanDays < MIN_SPAN_FOR_YEAR_OVER_YEAR_DAYS) {
    return unknown(
      `Only ${Math.round(spanDays)} days of history; at least ${MIN_SPAN_FOR_YEAR_OVER_YEAR_DAYS} are needed to compare the last 90 days with the same window last year.`
    );
  }

  const recentStart = last - RECENT_WINDOW_DAYS * DAY_MS;
  const priorEnd = last - 365 * DAY_MS;
  const priorStart = priorEnd - RECENT_WINDOW_DAYS * DAY_MS;

  const rawRecent = inWindow(sorted, recentStart, last);
  const prior = inWindow(sorted, priorStart, priorEnd);
  if (rawRecent.length < MIN_POINTS_PER_WINDOW || prior.length < MIN_POINTS_PER_WINDOW) {
    return unknown(
      `Too few points in the recent (${rawRecent.length}) or year-ago (${prior.length}) 90-day window to compare them.`
    );
  }

  const flags: TrendFlag[] = [];
  const { points, spiked } = smoothRecentSpikes(sorted, recentStart, last);
  if (spiked) flags.push('ONE_WEEK_SPIKE');

  const recentMean = mean(inWindow(points, recentStart, last).map((p) => p.value));
  const priorYearMean = mean(prior.map((p) => p.value));

  if (recentMean < MIN_MEANINGFUL_LEVEL && priorYearMean < MIN_MEANINGFUL_LEVEL) {
    return {
      ...unknown(
        `Search interest is negligible (recent mean ${round(recentMean)}, year-ago mean ${round(priorYearMean)}; below ${MIN_MEANINGFUL_LEVEL}).`,
        flags
      ),
      recentMean: round(recentMean),
      priorYearMean: round(priorYearMean),
    };
  }

  const seasonalityTestable = spanDays >= MIN_SPAN_FOR_SEASONAL_DAYS;
  const blocks = seasonalityTestable ? buildYearBlocks(sorted, last) : [];
  const seasonal = seasonalityTestable && isSeasonal(blocks);
  if (!seasonalityTestable) flags.push('SEASONALITY_NOT_TESTED');

  const tinyBase = priorYearMean < MIN_MEANINGFUL_LEVEL;
  if (tinyBase) flags.push('TINY_BASE');

  const ratio = tinyBase ? Number.POSITIVE_INFINITY : recentMean / priorYearMean;
  const yoyChangePercent = tinyBase ? null : round((ratio - 1) * 100);
  const result = (classification: TrendClassification, reason: string): TrendAnalysis => ({
    classification,
    reason,
    flags,
    recentMean: round(recentMean),
    priorYearMean: round(priorYearMean),
    yoyChangePercent,
  });

  const stable = ratio > DECLINE_RATIO && ratio < GROWTH_RATIO;

  if (seasonal && stable) {
    return result(
      'SEASONAL',
      'Interest repeats the same yearly shape and the last 90 days match the same window last year; not growth.'
    );
  }
  if (seasonal) flags.push('SEASONAL_COMPONENT');

  if (!seasonal && isDecayedBurst(points, recentStart, recentMean)) {
    return result('FAD', 'A single burst under 8 weeks long that has decayed back near baseline.');
  }

  if (ratio >= GROWTH_RATIO) {
    if (tinyBase) {
      return result(
        'EMERGING',
        `Interest rose from a near-zero base (year-ago mean ${round(priorYearMean)}) to ${round(recentMean)}; the percentage is not meaningful, treat as unconfirmed.`
      );
    }
    const lastMonth = inWindow(points, last - LAST_MONTH_DAYS * DAY_MS, last).map((p) => p.value);
    const previous = inWindow(points, recentStart - RECENT_WINDOW_DAYS * DAY_MS, recentStart).map(
      (p) => p.value
    );
    const lastMonthRatio = lastMonth.length > 0 ? mean(lastMonth) / recentMean : 1;
    const previousRatio =
      previous.length >= MIN_POINTS_PER_WINDOW ? recentMean / mean(previous) : 1;
    const atHigh = recentMean >= PEAK_PROXIMITY * maxRollingMean(points);
    const growth = `up ${yoyChangePercent}% vs the same 90 days last year`;

    if (atHigh && lastMonthRatio <= PEAK_FLATTENING_RATIO) {
      return result('PEAK', `At its all-time high (${growth}) but no longer rising; may be near peak.`);
    }
    if (
      lastMonthRatio >= ACCELERATION_LAST_MONTH_RATIO &&
      previousRatio >= ACCELERATION_PREVIOUS_WINDOW_RATIO
    ) {
      return result('ACCELERATING', `Interest ${growth} and still speeding up over the last month.`);
    }
    return result('EMERGING', `Interest ${growth}, not yet at its high.`);
  }

  if (ratio <= DECLINE_RATIO) {
    return result(
      'DECLINING',
      `Interest down ${Math.abs(yoyChangePercent ?? 0)}% vs the same 90 days last year.`
    );
  }

  // Stable vs last year and not seasonal.
  if (!seasonalityTestable) {
    return result(
      'UNKNOWN',
      'Level is steady vs last year, but under 2 years of history cannot tell evergreen from seasonal.'
    );
  }
  const overallMean = mean(sorted.map((p) => p.value));
  const evergreen =
    blocks.length >= 2 &&
    blocks.every(
      (block) =>
        block.mean >= MIN_MEANINGFUL_LEVEL &&
        Math.abs(block.mean - overallMean) / overallMean <= EVERGREEN_MAX_YEARLY_DEVIATION
    );
  return evergreen
    ? result('EVERGREEN', 'Steady level across every year with no repeating seasonal shape.')
    : result(
        'UNKNOWN',
        'Year-over-year change is inside the growth/decline bars, but yearly levels differ too much to call it evergreen.'
      );
}
