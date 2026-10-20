import { describe, expect, it } from 'vitest';
import { analyzeTrendSeries, type TrendPoint } from './trend-series';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const END = Date.UTC(2026, 9, 4); // 2026-10-04

/** Weekly series ending at END; `value` receives each point's age in weeks, oldest point first. */
function weekly(weeks: number, value: (weeksAgo: number, date: Date) => number): TrendPoint[] {
  const points: TrendPoint[] = [];
  for (let weeksAgo = weeks - 1; weeksAgo >= 0; weeksAgo--) {
    const date = new Date(END - weeksAgo * WEEK_MS);
    points.push({ date, value: value(weeksAgo, date) });
  }
  return points;
}

/** Deterministic, mild noise so flat lines are not perfectly constant. */
const noise = (i: number): number => Math.sin(i * 12.9898) * 1.5;

/** Cosine peaking every Dec 15. */
function christmasShape(w: number, date: Date): number {
  const peak = Date.UTC(2025, 11, 15);
  const phase = ((date.getTime() - peak) / (365 * DAY_MS)) * 2 * Math.PI;
  return 40 + 35 * Math.cos(phase) + noise(w);
}

describe('analyzeTrendSeries', () => {
  it('returns UNKNOWN on too few points, never a label', () => {
    const result = analyzeTrendSeries(weekly(10, () => 50));

    expect(result.classification).toBe('UNKNOWN');
    expect(result.reason).toMatch(/Only 10 data point/);
  });

  it('returns UNKNOWN when history is too short for a year-ago comparison', () => {
    const result = analyzeTrendSeries(weekly(40, (w) => 80 - w));

    expect(result.classification).toBe('UNKNOWN');
    expect(result.reason).toMatch(/days of history/);
  });

  it('returns UNKNOWN for a series with invalid points', () => {
    const points = weekly(120, () => 40);
    points[3] = { date: new Date('nope'), value: 1 };

    expect(analyzeTrendSeries(points).classification).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for negligible interest', () => {
    const result = analyzeTrendSeries(weekly(120, (w) => 1 + (w % 2)));

    expect(result.classification).toBe('UNKNOWN');
    expect(result.reason).toMatch(/negligible/);
  });

  it('labels a repeating yearly shape SEASONAL, not EMERGING, while the last 90 days are climbing', () => {
    // The series ends Oct 4, in the seasonal ramp-up toward the Dec peak.
    const result = analyzeTrendSeries(weekly(260, christmasShape));

    expect(result.classification).toBe('SEASONAL');
    expect(result.reason).toMatch(/not growth/);
  });

  it('does not call a series seasonal with only 15 months of history and flags it as untested', () => {
    const result = analyzeTrendSeries(weekly(66, christmasShape));

    expect(result.classification).not.toBe('SEASONAL');
    expect(result.flags).toContain('SEASONALITY_NOT_TESTED');
  });

  it('flags a breakout from a tiny base and refuses a confident percentage', () => {
    const result = analyzeTrendSeries(weekly(120, (w) => (w < 12 ? 30 + (11 - w) : 2)));

    expect(result.flags).toContain('TINY_BASE');
    expect(result.classification).toBe('EMERGING');
    expect(result.yoyChangePercent).toBeNull();
    expect(result.reason).toMatch(/not meaningful/);
  });

  it('classifies sustained year-over-year growth as EMERGING', () => {
    // Climbs well above last year, then eases off its high.
    const result = analyzeTrendSeries(
      weekly(130, (w) => {
        if (w > 52) return 25 + noise(w);
        if (w > 20) return 25 + (52 - w) * 1.5;
        return 40 + noise(w);
      })
    );

    expect(result.classification).toBe('EMERGING');
    expect(result.yoyChangePercent).toBeGreaterThan(50);
  });

  it('classifies growth that keeps speeding up as ACCELERATING', () => {
    const result = analyzeTrendSeries(
      weekly(130, (w) => (w > 26 ? 20 + noise(w) : 20 + (26 - w) ** 1.6 * 0.9))
    );

    expect(result.classification).toBe('ACCELERATING');
  });

  it('flags a one-week spike in the last 90 days instead of calling it a trend', () => {
    const result = analyzeTrendSeries(weekly(120, (w) => (w === 3 ? 100 : 20 + noise(w))));

    expect(result.flags).toContain('ONE_WEEK_SPIKE');
    expect(['EMERGING', 'ACCELERATING', 'PEAK']).not.toContain(result.classification);
  });

  it('labels a single short burst that decayed back to baseline a FAD', () => {
    const burst = [30, 100, 70, 40];
    const result = analyzeTrendSeries(
      weekly(120, (w) => {
        const index = 60 - w;
        return index >= 0 && index < burst.length ? burst[index]! : 8 + noise(w);
      })
    );

    expect(result.classification).toBe('FAD');
  });

  it('classifies a clear year-over-year fall as DECLINING', () => {
    const result = analyzeTrendSeries(weekly(130, (w) => (w > 52 ? 60 + noise(w) : 25 + noise(w))));

    expect(result.classification).toBe('DECLINING');
  });

  it('classifies a flat multi-year series as EVERGREEN', () => {
    const result = analyzeTrendSeries(weekly(260, (w) => 45 + noise(w)));

    expect(result.classification).toBe('EVERGREEN');
  });

  it('keeps a steady series with under 2 years of history UNKNOWN', () => {
    const result = analyzeTrendSeries(weekly(80, (w) => 45 + noise(w)));

    expect(result.classification).toBe('UNKNOWN');
    expect(result.reason).toMatch(/under 2 years/);
  });
});
