import { beforeEach, describe, expect, it, vi } from 'vitest';

// Boundary mock only: the DB. The goal is to prove the response-sanitization
// boundary (S7) — raw internal error text stored in the `errors` JSON column
// must never reach the client verbatim.
const findUniqueMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: { researchRun: { findUnique: findUniqueMock } },
}));

const { GET } = await import('./route');

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('GET /api/research-runs/[id]', () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
  });

  it('returns 404 when the run does not exist', async () => {
    findUniqueMock.mockResolvedValue(null);

    const response = await GET(new Request('http://localhost'), makeParams('missing'));

    expect(response.status).toBe(404);
  });

  it('queries with an explicit select rather than the full row', async () => {
    findUniqueMock.mockResolvedValue({
      id: 'run-1',
      startedAt: new Date('2026-01-01'),
      finishedAt: null,
      sources: ['REDDIT'],
      status: 'COMPLETED',
      candidateCount: 1,
      errors: [],
      niche: 'pet accessories',
      subreddits: [],
      createdAt: new Date('2026-01-01'),
      candidates: [],
    });

    await GET(new Request('http://localhost'), makeParams('run-1'));

    expect(findUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run-1' },
        select: expect.any(Object),
      })
    );
  });

  // S7 regression test: a raw, multi-line, oversized driver/schema error
  // message must never reach the client verbatim — it's truncated to a
  // short single line instead. (Truncation is a deliberate, cheap bound on
  // exposure, not a claim that every internal-looking substring is
  // stripped — a fuller error taxonomy is future work.)
  it('truncates an oversized, multi-line error message to a short single line', async () => {
    const rawPrismaLikeError =
      'Invalid `prisma.demandObservation.create()` invocation in\n' +
      '/home/app/src/features/discovery/pipeline.ts:201:34\n\n' +
      'Unique constraint failed on the fields: (`productId`,`source`,`sourceItemId`)'.repeat(5);

    findUniqueMock.mockResolvedValue({
      id: 'run-1',
      startedAt: new Date('2026-01-01'),
      finishedAt: new Date('2026-01-01'),
      sources: ['REDDIT'],
      status: 'PARTIAL',
      candidateCount: 1,
      errors: [{ source: 'pipeline', message: rawPrismaLikeError, occurredAt: '2026-01-01T00:00:00.000Z' }],
      niche: 'pet accessories',
      subreddits: [],
      createdAt: new Date('2026-01-01'),
      candidates: [],
    });

    const response = await GET(new Request('http://localhost'), makeParams('run-1'));
    const body = (await response.json()) as { run: { errors: Array<{ message: string }> } };

    expect(response.status).toBe(200);
    expect(body.run.errors).toHaveLength(1);
    expect(rawPrismaLikeError.length).toBeGreaterThan(200);
    expect(body.run.errors[0]!.message.length).toBeLessThanOrEqual(200);
    expect(body.run.errors[0]!.message).not.toContain('\n');
  });

  // S7 regression test: truncation alone (the previous implementation) never
  // actually removed the leaked Prisma invocation text or the absolute file
  // path — a 200-char slice of this exact message still contains both in
  // full. The fix replaces the whole message with a fixed generic string
  // whenever it matches this known internal-error shape, so the leaked
  // detail is verified GONE, not just shorter.
  it('strips a leaked Prisma invocation message and absolute file path instead of merely shortening them', async () => {
    const rawPrismaLikeError =
      'Invalid `prisma.demandObservation.create()` invocation in\n' +
      'C:\\Users\\user\\Documents\\projects\\personal\\product-intelligence-engine\\src\\features\\discovery\\pipeline.ts:201:34\n\n' +
      'Unique constraint failed on the fields: (`productId`,`source`,`sourceItemId`)';

    findUniqueMock.mockResolvedValue({
      id: 'run-1',
      startedAt: new Date('2026-01-01'),
      finishedAt: new Date('2026-01-01'),
      sources: ['REDDIT'],
      status: 'PARTIAL',
      candidateCount: 1,
      errors: [{ source: 'pipeline', message: rawPrismaLikeError, occurredAt: '2026-01-01T00:00:00.000Z' }],
      niche: 'pet accessories',
      subreddits: [],
      createdAt: new Date('2026-01-01'),
      candidates: [],
    });

    const response = await GET(new Request('http://localhost'), makeParams('run-1'));
    const body = (await response.json()) as { run: { errors: Array<{ message: string }> } };

    const sanitized = body.run.errors[0]!.message;
    expect(sanitized).not.toContain('prisma.demandObservation.create');
    expect(sanitized).not.toMatch(/[A-Za-z]:\\/);
    expect(sanitized).not.toContain('pipeline.ts');
    expect(sanitized).toBe('Internal error (see server logs)');
  });

  // S7 regression test: a POSIX absolute path leaking without the
  // "Invalid `prisma." prefix (e.g. a raw Node fs/module error) must also be
  // caught by the generic shape match, not just Prisma-specific messages.
  it('strips a bare POSIX absolute file path that leaks outside a Prisma-shaped message', async () => {
    const rawFsError = 'ENOENT: no such file or directory, open /home/app/src/features/discovery/pipeline.ts';

    findUniqueMock.mockResolvedValue({
      id: 'run-1',
      startedAt: new Date('2026-01-01'),
      finishedAt: new Date('2026-01-01'),
      sources: ['REDDIT'],
      status: 'PARTIAL',
      candidateCount: 1,
      errors: [{ source: 'pipeline', message: rawFsError, occurredAt: '2026-01-01T00:00:00.000Z' }],
      niche: 'pet accessories',
      subreddits: [],
      createdAt: new Date('2026-01-01'),
      candidates: [],
    });

    const response = await GET(new Request('http://localhost'), makeParams('run-1'));
    const body = (await response.json()) as { run: { errors: Array<{ message: string }> } };

    expect(body.run.errors[0]!.message).toBe('Internal error (see server logs)');
  });

  // A normal, non-sensitive message that happens to contain an http(s) URL
  // (e.g. a source adapter's own error text) must NOT be swept up by the
  // path-stripping pattern and replaced with the generic string.
  it('does not treat an ordinary message containing an http(s) URL as a leaked internal path', async () => {
    findUniqueMock.mockResolvedValue({
      id: 'run-1',
      startedAt: new Date('2026-01-01'),
      finishedAt: new Date('2026-01-01'),
      sources: ['REDDIT'],
      status: 'PARTIAL',
      candidateCount: 1,
      errors: [
        {
          source: 'REDDIT',
          message:
            'Reddit request failed for https://www.reddit.com/r/banned/hot.json: 403 Forbidden',
          occurredAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      niche: 'pet accessories',
      subreddits: [],
      createdAt: new Date('2026-01-01'),
      candidates: [],
    });

    const response = await GET(new Request('http://localhost'), makeParams('run-1'));
    const body = (await response.json()) as { run: { errors: Array<{ message: string }> } };

    expect(body.run.errors[0]!.message).toBe(
      'Reddit request failed for https://www.reddit.com/r/banned/hot.json: 403 Forbidden'
    );
  });

  it('drops a malformed error entry instead of forwarding whatever shape it has', async () => {
    findUniqueMock.mockResolvedValue({
      id: 'run-1',
      startedAt: new Date('2026-01-01'),
      finishedAt: null,
      sources: ['REDDIT'],
      status: 'PARTIAL',
      candidateCount: 0,
      errors: [{ unexpected: 'shape' }, 'not even an object'],
      niche: 'pet accessories',
      subreddits: [],
      createdAt: new Date('2026-01-01'),
      candidates: [],
    });

    const response = await GET(new Request('http://localhost'), makeParams('run-1'));
    const body = (await response.json()) as { run: { errors: unknown[] } };

    expect(body.run.errors).toHaveLength(0);
  });
});
