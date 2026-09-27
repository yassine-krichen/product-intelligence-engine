import { describe, expect, it } from 'vitest';
import { computeDemandMomentum, type DemandPoint } from './demand-momentum';

function point(value: number, daysAgo: number): DemandPoint {
  const observedAt = new Date();
  observedAt.setDate(observedAt.getDate() - daysAgo);
  return { value, observedAt };
}

describe('computeDemandMomentum', () => {
  it('returns INSUFFICIENT_DATA with a reason and null score for zero observations', () => {
    const result = computeDemandMomentum([]);

    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.score).toBeNull();
    expect(result.reason).toMatch(/0 demand observation/);
  });

  it('returns INSUFFICIENT_DATA with a reason and null score for exactly one observation', () => {
    const result = computeDemandMomentum([point(100, 0)]);

    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.score).toBeNull();
    expect(result.reason).toMatch(/1 demand observation/);
    expect(result.reason).toMatch(/at least 2 are needed/);
  });

  it('never fabricates a score when data is insufficient', () => {
    const result = computeDemandMomentum([point(9999, 0)]);
    // The discriminated union makes this a compile-time guarantee too, but
    // assert it explicitly: an INSUFFICIENT_DATA result must never carry a
    // numeric score under any circumstance.
    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.score).toBeNull();
  });

  it('scores a flat trend (no change between earliest and latest) as 50', () => {
    const result = computeDemandMomentum([point(100, 10), point(100, 0)]);

    expect(result.status).toBe('COMPUTED');
    expect(result.score).toBe(50);
    expect(result.reason).toBeNull();
  });

  it('scores a doubled trend as (clamped to) 100', () => {
    const result = computeDemandMomentum([point(100, 10), point(200, 0)]);

    expect(result.status).toBe('COMPUTED');
    expect(result.score).toBe(100);
  });

  it('clamps a more-than-doubled trend at 100 rather than exceeding the scale', () => {
    const result = computeDemandMomentum([point(100, 10), point(10_000, 0)]);

    expect(result.status).toBe('COMPUTED');
    expect(result.score).toBe(100);
  });

  it('scores a collapsed trend (down to near zero) as (clamped to) 0', () => {
    const result = computeDemandMomentum([point(100, 10), point(0, 0)]);

    expect(result.status).toBe('COMPUTED');
    expect(result.score).toBe(0);
  });

  it('sorts by observedAt internally, independent of input order', () => {
    // Latest point listed first in the array — the function must sort by
    // observedAt itself rather than trusting array order.
    const outOfOrder = computeDemandMomentum([point(200, 0), point(100, 10)]);
    const inOrder = computeDemandMomentum([point(100, 10), point(200, 0)]);

    expect(outOfOrder).toEqual(inOrder);
    expect(outOfOrder.score).toBe(100);
  });

  it('always returns an integer 0-100 score for COMPUTED results, never null', () => {
    const result = computeDemandMomentum([point(50, 10), point(65, 0)]);

    expect(result.status).toBe('COMPUTED');
    if (result.status === 'COMPUTED') {
      expect(Number.isInteger(result.score)).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    }
  });

  describe('B3: near-zero baseline guard', () => {
    it('returns INSUFFICIENT_DATA instead of a fabricated 100 when going from 0 to any positive value', () => {
      const result = computeDemandMomentum([point(0, 10), point(50, 0)]);

      expect(result.status).toBe('INSUFFICIENT_DATA');
      expect(result.score).toBeNull();
      expect(result.reason).toMatch(/too small to measure a meaningful percent change/);
    });

    it('returns INSUFFICIENT_DATA when the baseline is small but nonzero (below the floor)', () => {
      const result = computeDemandMomentum([point(1, 10), point(3, 0)]);

      expect(result.status).toBe('INSUFFICIENT_DATA');
      expect(result.score).toBeNull();
      expect(result.reason).toMatch(/Baseline value \(1\)/);
    });

    it('computes normally once the baseline meets the meaningful-change floor', () => {
      const result = computeDemandMomentum([point(5, 10), point(10, 0)]);

      expect(result.status).toBe('COMPUTED');
      expect(result.score).toBe(100);
    });

    it('does not apply the near-zero floor to the latest value, only the baseline', () => {
      // Baseline (earliest) is well above the floor; a collapse to 0 is a
      // real, reportable signal, not "insufficient data".
      const result = computeDemandMomentum([point(100, 10), point(0, 0)]);

      expect(result.status).toBe('COMPUTED');
      expect(result.score).toBe(0);
    });
  });
});
