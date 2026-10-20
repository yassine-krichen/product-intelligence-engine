import { beforeEach, describe, expect, it, vi } from 'vitest';

// Boundary mock only: Prisma. Scoring and normalization run for real.
const prismaMock = vi.hoisted(() => ({
  product: { findUnique: vi.fn(), upsert: vi.fn(), findMany: vi.fn() },
  researchEvidence: { upsert: vi.fn(), findMany: vi.fn() },
  productScoreDimension: { findMany: vi.fn(), upsert: vi.fn() },
  demandObservation: { findMany: vi.fn() },
}));
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

const {
  addCandidate,
  addEvidence,
  CandidateNotFoundError,
  InvalidCandidateNameError,
  listCandidates,
  showCandidate,
} = await import('./ledger.service');

const productRow = { id: 'p1', canonicalName: 'LED Dog Collar', niche: 'pets', description: null };

beforeEach(() => {
  vi.resetAllMocks();
});

describe('addCandidate', () => {
  it('upserts on the normalized name and reports created=true for a new candidate', async () => {
    prismaMock.product.findUnique.mockResolvedValue(null);
    prismaMock.product.upsert.mockResolvedValue({ id: 'p1', canonicalName: 'LED Dog Collar', niche: 'pets', description: null });

    const result = await addCandidate({ name: 'LED Dog Collar', niche: 'pets' });

    expect(result.created).toBe(true);
    expect(prismaMock.product.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { normalizedName: 'led dog collar' },
        create: expect.objectContaining({ canonicalName: 'LED Dog Collar', niche: 'pets' }),
      })
    );
  });

  it('is idempotent: a differently-written duplicate hits the same key, reports created=false, and never overwrites the niche', async () => {
    prismaMock.product.findUnique.mockResolvedValue({ id: 'p1' });
    prismaMock.product.upsert.mockResolvedValue(productRow);

    const result = await addCandidate({ name: 'led dog collar!', niche: 'something else' });

    expect(result.created).toBe(false);
    const call = prismaMock.product.upsert.mock.calls[0]![0] as { where: unknown; update: unknown };
    expect(call.where).toEqual({ normalizedName: 'led dog collar' });
    expect(call.update).toEqual({});
  });

  it('updates only the description of an existing candidate when one is supplied', async () => {
    prismaMock.product.findUnique.mockResolvedValue({ id: 'p1' });
    prismaMock.product.upsert.mockResolvedValue(productRow);

    await addCandidate({ name: 'LED Dog Collar', niche: 'pets', description: 'glows' });

    const call = prismaMock.product.upsert.mock.calls[0]![0] as { update: unknown };
    expect(call.update).toEqual({ description: 'glows' });
  });

  it('rejects a name that normalizes to nothing without touching the database', async () => {
    await expect(addCandidate({ name: 'The Show!!!', niche: 'pets' })).rejects.toBeInstanceOf(
      InvalidCandidateNameError
    );
    expect(prismaMock.product.upsert).not.toHaveBeenCalled();
  });
});

describe('addEvidence', () => {
  const input = {
    source: 'AMAZON_MOVERS_SHAKERS' as const,
    claim: 'Movers rank 4',
    url: 'https://www.amazon.com/gp/movers-and-shakers/pet-supplies',
    method: 'AGENT_WEB_READ' as const,
    observedAt: new Date('2026-10-01T00:00:00Z'),
    metric: 'rank',
    numericValue: 4,
    unit: 'position',
    excerpt: '#4 LED Dog Collar',
  };

  it('resolves the candidate by id and stores the structured fields via the natural-key upsert', async () => {
    prismaMock.product.findUnique.mockResolvedValueOnce(productRow);
    prismaMock.researchEvidence.upsert.mockResolvedValue({ id: 'e1' });

    const result = await addEvidence('p1', input);

    expect(result.id).toBe('e1');
    const call = prismaMock.researchEvidence.upsert.mock.calls[0]![0] as {
      where: unknown;
      create: Record<string, unknown>;
    };
    expect(call.where).toEqual({
      researchEvidence_naturalKey: {
        productId: 'p1',
        source: 'AMAZON_MOVERS_SHAKERS',
        claim: 'Movers rank 4',
        observedAt: input.observedAt,
      },
    });
    expect(call.create).toMatchObject({
      method: 'AGENT_WEB_READ',
      metric: 'rank',
      numericValue: 4,
      unit: 'position',
      excerpt: '#4 LED Dog Collar',
      url: input.url,
      value: '4 position',
    });
  });

  it('falls back to a normalized-name lookup when the reference is not an id', async () => {
    prismaMock.product.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(productRow);
    prismaMock.researchEvidence.upsert.mockResolvedValue({ id: 'e1' });

    await addEvidence('LED dog collar', input);

    expect(prismaMock.product.findUnique).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { normalizedName: 'led dog collar' } })
    );
  });

  it('fails with CandidateNotFoundError and writes nothing when no candidate matches', async () => {
    prismaMock.product.findUnique.mockResolvedValue(null);

    await expect(addEvidence('ghost', input)).rejects.toBeInstanceOf(CandidateNotFoundError);
    expect(prismaMock.researchEvidence.upsert).not.toHaveBeenCalled();
  });

  it('stores a qualitative claim with no numeric fields', async () => {
    prismaMock.product.findUnique.mockResolvedValueOnce(productRow);
    prismaMock.researchEvidence.upsert.mockResolvedValue({ id: 'e2' });

    await addEvidence('p1', { source: 'REDDIT', claim: 'People ask for it', url: input.url, method: 'AGENT_WEB_READ', observedAt: input.observedAt });

    const call = prismaMock.researchEvidence.upsert.mock.calls[0]![0] as { create: Record<string, unknown> };
    expect(call.create).toMatchObject({ metric: null, numericValue: null, unit: null, value: null });
  });
});

describe('listCandidates and showCandidate', () => {
  const measured = (source: string) => ({
    source,
    method: 'API',
    // Distinct page per source: one URL can only count for one source.
    url: `https://example.com/${source}`,
    claim: 'c',
    metric: 'm',
    numericValue: 1,
    unit: null,
  });

  it('computes a verdict per candidate and filters by it', async () => {
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'a', canonicalName: 'A', niche: 'n', evidence: [measured('GOOGLE_TRENDS'), measured('HACKER_NEWS')] },
      { id: 'b', canonicalName: 'B', niche: 'n', evidence: [measured('GOOGLE_TRENDS')] },
      { id: 'c', canonicalName: 'C', niche: 'n', evidence: [] },
    ]);

    const all = await listCandidates({ limit: 50 });
    expect(all.map((c) => [c.name, c.verdict])).toEqual([
      ['A', 'PROMISING'],
      ['B', 'WEAK'],
      ['C', 'UNVERIFIED'],
    ]);

    prismaMock.product.findMany.mockResolvedValue([
      { id: 'a', canonicalName: 'A', niche: 'n', evidence: [measured('GOOGLE_TRENDS'), measured('HACKER_NEWS')] },
      { id: 'b', canonicalName: 'B', niche: 'n', evidence: [] },
    ]);
    const promising = await listCandidates({ verdict: 'PROMISING', limit: 50 });
    expect(promising.map((c) => c.name)).toEqual(['A']);
  });

  it('show returns the evidence ledger, verdict, dimensions and gaps', async () => {
    prismaMock.product.findUnique.mockResolvedValueOnce(productRow);
    prismaMock.researchEvidence.findMany.mockResolvedValue([
      { ...measured('GOOGLE_TRENDS'), id: 'e1', value: '1', excerpt: null, observedAt: new Date('2026-10-01T00:00:00Z') },
    ]);
    prismaMock.productScoreDimension.findMany.mockResolvedValue([
      { dimension: 'DEMAND_MOMENTUM', status: 'INSUFFICIENT_DATA', score: null, reason: 'no data' },
    ]);

    const detail = await showCandidate('p1');

    expect(detail.assessment.verdict).toBe('WEAK');
    expect(detail.assessment.gaps.length).toBeGreaterThan(0);
    expect(detail.evidence[0]).toMatchObject({ id: 'e1', observedAt: '2026-10-01T00:00:00.000Z' });
    expect(detail.scoreDimensions).toHaveLength(1);
  });
});
