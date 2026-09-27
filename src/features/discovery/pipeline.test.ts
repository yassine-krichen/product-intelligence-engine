import { beforeEach, describe, expect, it, vi } from 'vitest';

// pipeline.ts imports '@/lib/prisma' (and transitively, the scoring module,
// which also imports it) at module scope. Most tests below only exercise the
// pure orchestration functions (grouping + fan-out discovery), so the DB
// client only needs to exist, not do anything real — the `runNicheHunt`
// guard test further down attaches vi.fn() stubs to `researchRun` itself.
vi.mock('@/lib/prisma', () => ({ prisma: { researchRun: {} } }));

const { groupByNormalizedName, discoverFromSources, runNicheHunt } = await import('./pipeline');
const { normalizeTitle } = await import('./normalize');
const { prisma } = await import('@/lib/prisma');

import type { DiscoverResult, DiscoveryInput, ProductSource, RawProduct } from './source.types';

function rawProduct(overrides: Partial<RawProduct> & { title: string }): RawProduct {
  return {
    source: overrides.source ?? 'REDDIT',
    externalId: overrides.externalId ?? Math.random().toString(36),
    title: overrides.title,
    url: overrides.url ?? 'https://example.com',
    observedAt: overrides.observedAt ?? new Date(),
    metrics: overrides.metrics ?? {},
    raw: overrides.raw ?? {},
  };
}

function fakeSource(
  id: ProductSource['id'],
  discover: (input: DiscoveryInput) => Promise<DiscoverResult>
): ProductSource {
  return {
    id,
    discover,
    enrich: async () => [],
    healthCheck: async () => ({ id, status: 'HEALTHY', checkedAt: new Date() }),
  };
}

describe('groupByNormalizedName', () => {
  it('deduplicates raw signals that normalize to the same name', () => {
    const items = [
      rawProduct({ title: 'LED Dog Collar', externalId: 'a' }),
      rawProduct({ title: 'led dog collar!', externalId: 'b' }),
      rawProduct({ title: 'Show HN: LED Dog Collar', externalId: 'c' }),
    ];

    const { groups } = groupByNormalizedName(items);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.normalizedName).toBe(normalizeTitle('LED Dog Collar'));
    expect(groups[0]!.items).toHaveLength(3);
  });

  it('keeps genuinely different products in separate groups', () => {
    const items = [
      rawProduct({ title: 'LED Dog Collar', externalId: 'a' }),
      rawProduct({ title: 'Portable Blender', externalId: 'b' }),
    ];

    const { groups } = groupByNormalizedName(items);

    expect(groups).toHaveLength(2);
  });

  it('drops items whose title normalizes to nothing (pure stopwords/punctuation), and reports them as dropped', () => {
    const droppedItem = rawProduct({ title: 'The Show For You', externalId: 'a' });
    const items = [droppedItem, rawProduct({ title: 'LED Dog Collar', externalId: 'b' })];

    const { groups, dropped } = groupByNormalizedName(items);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.items).toHaveLength(1);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toBe(droppedItem);
  });

  it('returns an empty dropped list when every title normalizes to something', () => {
    const items = [rawProduct({ title: 'LED Dog Collar', externalId: 'a' })];

    const { dropped } = groupByNormalizedName(items);

    expect(dropped).toHaveLength(0);
  });

  it('uses the first item title (trimmed) as the group canonical name', () => {
    const items = [
      rawProduct({ title: '  LED Dog Collar  ', externalId: 'a' }),
      rawProduct({ title: 'led dog collar', externalId: 'b' }),
    ];

    const { groups } = groupByNormalizedName(items);

    expect(groups[0]!.canonicalName).toBe('LED Dog Collar');
  });
});

describe('discoverFromSources', () => {
  const input: DiscoveryInput = { niche: 'pet accessories', limit: 25 };

  it('collects raw products from every source that succeeds', async () => {
    const sourceA = fakeSource('REDDIT', async () => ({
      items: [rawProduct({ title: 'Product A' })],
      warnings: [],
    }));
    const sourceB = fakeSource('HACKER_NEWS', async () => ({
      items: [rawProduct({ title: 'Product B' })],
      warnings: [],
    }));

    const { rawProducts, errors } = await discoverFromSources([sourceA, sourceB], input);

    expect(rawProducts).toHaveLength(2);
    expect(errors).toHaveLength(0);
  });

  // S6 regression test: a source can succeed overall (some items returned)
  // while still losing part of its own input (e.g. one subreddit of several
  // failing to fetch). That partial failure must be recorded on the run's
  // error trail, not just reach a console log no one downstream ever sees.
  it('records a source-reported partial-failure warning as a run error even when the source itself succeeds', async () => {
    const partiallyFailingSource = fakeSource('REDDIT', async () => ({
      items: [rawProduct({ title: 'Surviving Product' })],
      warnings: [{ message: 'Partial Reddit fetch failure: r/banned: 403 Forbidden' }],
    }));

    const { rawProducts, errors } = await discoverFromSources([partiallyFailingSource], input);

    // The successful items still come through...
    expect(rawProducts).toHaveLength(1);
    // ...and the partial failure is recorded as data, not silently dropped.
    expect(errors).toHaveLength(1);
    expect(errors[0]!.source).toBe('REDDIT');
    expect(errors[0]!.message).toMatch(/r\/banned: 403 Forbidden/);
  });

  it('does not abort the run when one source throws — partial results are kept and the error recorded', async () => {
    const healthySource = fakeSource('HACKER_NEWS', async () => ({
      items: [rawProduct({ title: 'Surviving Product' })],
      warnings: [],
    }));
    const failingSource = fakeSource('REDDIT', async () => {
      throw new Error('Reddit request failed: 503 Service Unavailable');
    });

    const { rawProducts, errors } = await discoverFromSources(
      [failingSource, healthySource],
      input
    );

    // Partial results: the healthy source's product still comes through.
    expect(rawProducts).toHaveLength(1);
    expect(rawProducts[0]!.title).toBe('Surviving Product');

    // The failure is recorded as data, not swallowed and not thrown.
    expect(errors).toHaveLength(1);
    expect(errors[0]!.source).toBe('REDDIT');
    expect(errors[0]!.message).toMatch(/503/);
  });

  it('records a generic message for a non-Error throw instead of losing the failure', async () => {
    const failingSource = fakeSource('REDDIT', async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'not an Error instance';
    });

    const { rawProducts, errors } = await discoverFromSources([failingSource], input);

    expect(rawProducts).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe('Unknown discovery error');
  });

  it('returns no errors and empty results when there are no sources', async () => {
    const { rawProducts, errors } = await discoverFromSources([], input);

    expect(rawProducts).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});

// S2 regression tests: a late/buffered BullMQ delivery (ioredis's offline
// queue can replay a buffered `queue.add` once Redis reconnects, even after
// the API route already gave up and marked the run FAILED) must never revive
// a run that isn't PENDING anymore.
describe('runNicheHunt PENDING guard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (prisma as unknown as { researchRun: Record<string, unknown> }).researchRun = {};
  });

  it('exits without doing any work when the run is no longer PENDING', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findUniqueOrThrow = vi.fn();
    (prisma as unknown as { researchRun: Record<string, unknown> }).researchRun = {
      updateMany,
      findUniqueOrThrow,
    };

    await runNicheHunt({ runId: 'run-1', niche: 'pet accessories', subreddits: [] });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'run-1', status: 'PENDING' },
      data: { status: 'RUNNING' },
    });
    // Having found the run already moved on (FAILED by the route's enqueue
    // timeout, or already claimed), nothing else about this run is touched.
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
  });
});
