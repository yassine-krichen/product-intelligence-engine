import { beforeEach, describe, expect, it, vi } from 'vitest';

// score-dimensions.ts talks to Prisma directly. We mock only the DB
// boundary (not the scoring logic itself) so the test exercises the real
// grouping/threshold logic, the real computeDemandMomentum calculation, and
// the real "4 placeholder dimensions" wiring, while never touching an
// actual database.
const findManyMock = vi.fn();
const upsertMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    demandObservation: { findMany: findManyMock },
    productScoreDimension: { upsert: upsertMock },
  },
}));

const { computeScoresForProduct, computeDemandMomentumForProduct } = await import(
  './score-dimensions'
);

/** A DemandObservation row shaped exactly as Prisma would return it post-B1. */
function observation(overrides: {
  source?: string;
  sourceItemId?: string;
  metric?: string;
  value: number;
  observedAt: Date;
}) {
  return {
    source: overrides.source ?? 'REDDIT',
    sourceItemId: overrides.sourceItemId ?? 'post-1',
    metric: overrides.metric ?? 'ups',
    value: overrides.value,
    observedAt: overrides.observedAt,
  };
}

describe('computeScoresForProduct', () => {
  beforeEach(() => {
    findManyMock.mockReset();
    upsertMock.mockReset();
  });

  it('writes all 5 dimensions as separate rows, never a single combined score', async () => {
    findManyMock.mockResolvedValue([
      observation({ value: 100, observedAt: new Date('2026-01-01') }),
      observation({ value: 150, observedAt: new Date('2026-01-08') }),
    ]);

    await computeScoresForProduct('product-1');

    expect(upsertMock).toHaveBeenCalledTimes(5);
    const dimensionsWritten = upsertMock.mock.calls.map(
      (call) => call[0].create.dimension
    );
    expect(new Set(dimensionsWritten)).toEqual(
      new Set([
        'DEMAND_MOMENTUM',
        'ECONOMICS',
        'COMPETITION',
        'SUPPLIER_QUALITY',
        'PRODUCT_SUITABILITY',
      ])
    );
  });

  it('computes a real DEMAND_MOMENTUM score when the SAME tracked metric has >= 2 observations at different fetch times', async () => {
    findManyMock.mockResolvedValue([
      observation({ value: 100, observedAt: new Date('2026-01-01') }),
      observation({ value: 200, observedAt: new Date('2026-01-08') }),
    ]);

    await computeScoresForProduct('product-1');

    const demandCall = upsertMock.mock.calls.find(
      (call) => call[0].create.dimension === 'DEMAND_MOMENTUM'
    )!;
    expect(demandCall[0].create.status).toBe('COMPUTED');
    expect(demandCall[0].create.score).toBe(100);
    expect(demandCall[0].create.reason).toBeNull();
  });

  it('marks DEMAND_MOMENTUM as INSUFFICIENT_DATA (not a fabricated score) with < 2 observations', async () => {
    findManyMock.mockResolvedValue([observation({ value: 100, observedAt: new Date() })]);

    await computeScoresForProduct('product-1');

    const demandCall = upsertMock.mock.calls.find(
      (call) => call[0].create.dimension === 'DEMAND_MOMENTUM'
    )!;
    expect(demandCall[0].create.status).toBe('INSUFFICIENT_DATA');
    expect(demandCall[0].create.score).toBeNull();
    expect(demandCall[0].create.reason).toMatch(/observed at 2\+ different fetch times/);
  });

  // B1 regression test: this is exactly the shape the discovery pipeline
  // writes for a single research run — one Reddit post producing two
  // DIFFERENT metrics (ups, num_comments), both recorded at the SAME fetch
  // time. Before the fix, these were fed undifferentiated into
  // computeDemandMomentum as if they were two points in one time series,
  // producing a fabricated, misleadingly precise momentum score (e.g. -96%)
  // from a single snapshot of a single post.
  it('does NOT produce a misleadingly precise score for pipeline-shaped single-snapshot data (one post, two metrics, same observedAt)', async () => {
    const fetchedAt = new Date('2026-01-01T00:00:00.000Z');
    findManyMock.mockResolvedValue([
      observation({ sourceItemId: 'post-1', metric: 'ups', value: 500, observedAt: fetchedAt }),
      observation({
        sourceItemId: 'post-1',
        metric: 'num_comments',
        value: 20,
        observedAt: fetchedAt,
      }),
    ]);

    await computeScoresForProduct('product-1');

    const demandCall = upsertMock.mock.calls.find(
      (call) => call[0].create.dimension === 'DEMAND_MOMENTUM'
    )!;
    expect(demandCall[0].create.status).toBe('INSUFFICIENT_DATA');
    expect(demandCall[0].create.score).toBeNull();
  });

  it('always reports the 4 unimplemented dimensions as INSUFFICIENT_DATA in Phase 1', async () => {
    findManyMock.mockResolvedValue([
      observation({ value: 100, observedAt: new Date('2026-01-01') }),
      observation({ value: 200, observedAt: new Date('2026-01-08') }),
    ]);

    await computeScoresForProduct('product-1');

    const placeholderDimensions = [
      'ECONOMICS',
      'COMPETITION',
      'SUPPLIER_QUALITY',
      'PRODUCT_SUITABILITY',
    ];
    for (const dimension of placeholderDimensions) {
      const call = upsertMock.mock.calls.find(
        (c) => c[0].create.dimension === dimension
      )!;
      expect(call[0].create.status).toBe('INSUFFICIENT_DATA');
      expect(call[0].create.score).toBeNull();
      expect(call[0].create.reason).toBe('Not yet implemented (Phase 2/3).');
    }
  });
});

describe('computeDemandMomentumForProduct', () => {
  it('returns INSUFFICIENT_DATA with a reason for zero observations', () => {
    const result = computeDemandMomentumForProduct([]);

    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.score).toBeNull();
    expect(result.reason).toMatch(/no demand observations/i);
  });

  it('never compares ups against num_comments even from the same post at different observedAt values', () => {
    // Pathological/malformed input: two DIFFERENT metrics for the same post,
    // but at two different observedAt values. Even so, grouping is by
    // (source, sourceItemId, metric) — each metric only has 1 point, so
    // neither qualifies.
    const result = computeDemandMomentumForProduct([
      observation({ metric: 'ups', value: 10, observedAt: new Date('2026-01-01') }),
      observation({ metric: 'num_comments', value: 900, observedAt: new Date('2026-01-08') }),
    ]);

    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.score).toBeNull();
  });

  it('never compares one tracked item\'s series against a different item\'s series for the same product', () => {
    const result = computeDemandMomentumForProduct([
      observation({ sourceItemId: 'post-1', value: 10, observedAt: new Date('2026-01-01') }),
      observation({ sourceItemId: 'post-2', value: 900, observedAt: new Date('2026-01-08') }),
    ]);

    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.score).toBeNull();
  });

  it('computes momentum once the same (source, sourceItemId, metric) has 2+ observations at different fetch times', () => {
    const result = computeDemandMomentumForProduct([
      observation({ sourceItemId: 'post-1', metric: 'ups', value: 100, observedAt: new Date('2026-01-01') }),
      observation({ sourceItemId: 'post-1', metric: 'ups', value: 200, observedAt: new Date('2026-01-08') }),
    ]);

    expect(result.status).toBe('COMPUTED');
    expect(result.score).toBe(100);
  });
});
