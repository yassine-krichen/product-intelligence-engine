import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Boundary mocks only: the DB, the job queue, and the rate limiter. The goal
// is to prove the validation boundary itself — a malformed/malicious body
// must never reach prisma.researchRun.create or enqueueNicheHunt.
const createRunMock = vi.fn();
const updateRunMock = vi.fn();
const enqueueNicheHuntMock = vi.fn();
const isRateLimitedMock = vi.fn(() => false);

vi.mock('@/lib/prisma', () => ({
  prisma: { researchRun: { create: createRunMock, update: updateRunMock } },
}));
vi.mock('@/features/jobs/queue', () => ({
  enqueueNicheHunt: enqueueNicheHuntMock,
}));
vi.mock('@/lib/rate-limit', () => ({
  // GLOBAL_RATE_LIMIT_KEY is a plain string constant, not a function — no
  // need to fake its value, just re-export something stable.
  GLOBAL_RATE_LIMIT_KEY: 'single-tenant',
  isRateLimited: isRateLimitedMock,
}));

const { POST } = await import('./route');

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/research-runs', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function postRawBody(rawBody: string): NextRequest {
  return new NextRequest('http://localhost/api/research-runs', {
    method: 'POST',
    body: rawBody,
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/research-runs', () => {
  beforeEach(() => {
    createRunMock.mockReset();
    updateRunMock.mockReset();
    enqueueNicheHuntMock.mockReset();
    isRateLimitedMock.mockReset().mockReturnValue(false);
    createRunMock.mockResolvedValue({ id: 'run-1' });
    updateRunMock.mockResolvedValue({ id: 'run-1' });
    enqueueNicheHuntMock.mockResolvedValue(undefined);
  });

  it('rejects malformed JSON with 400 before touching the job queue', async () => {
    const response = await POST(postRawBody('{not valid json'));

    expect(response.status).toBe(400);
    expect(createRunMock).not.toHaveBeenCalled();
    expect(enqueueNicheHuntMock).not.toHaveBeenCalled();
  });

  it('rejects a missing niche with 400', async () => {
    const response = await POST(postRequest({ subreddits: ['petaccessories'] }));

    expect(response.status).toBe(400);
    expect(createRunMock).not.toHaveBeenCalled();
    expect(enqueueNicheHuntMock).not.toHaveBeenCalled();
  });

  it('rejects a too-short niche with 400', async () => {
    const response = await POST(postRequest({ niche: 'a' }));

    expect(response.status).toBe(400);
    expect(createRunMock).not.toHaveBeenCalled();
  });

  it('rejects a malicious/malformed subreddit name (path traversal) with 400 before enqueueing', async () => {
    const response = await POST(
      postRequest({ niche: 'pet accessories', subreddits: ['../../admin'] })
    );

    expect(response.status).toBe(400);
    expect(createRunMock).not.toHaveBeenCalled();
    expect(enqueueNicheHuntMock).not.toHaveBeenCalled();
  });

  it('rejects an SSRF-style absolute-URL subreddit with 400 before enqueueing', async () => {
    const response = await POST(
      postRequest({
        niche: 'pet accessories',
        subreddits: ['http://169.254.169.254/latest/meta-data'],
      })
    );

    expect(response.status).toBe(400);
    expect(createRunMock).not.toHaveBeenCalled();
    expect(enqueueNicheHuntMock).not.toHaveBeenCalled();
  });

  it('rejects a subreddit list over the max length with 400', async () => {
    const response = await POST(
      postRequest({
        niche: 'pet accessories',
        subreddits: Array.from({ length: 11 }, (_, i) => `sub${i}`),
      })
    );

    expect(response.status).toBe(400);
    expect(createRunMock).not.toHaveBeenCalled();
  });

  it('returns 429 and never reaches validation/enqueue when rate-limited', async () => {
    isRateLimitedMock.mockReturnValue(true);

    const response = await POST(postRequest({ niche: 'pet accessories' }));

    expect(response.status).toBe(429);
    expect(createRunMock).not.toHaveBeenCalled();
    expect(enqueueNicheHuntMock).not.toHaveBeenCalled();
  });

  it('accepts a well-formed request, creates the run, and enqueues the job', async () => {
    const response = await POST(
      postRequest({ niche: 'pet accessories', subreddits: ['petaccessories'] })
    );

    expect(response.status).toBe(202);
    expect(createRunMock).toHaveBeenCalledTimes(1);
    expect(enqueueNicheHuntMock).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', niche: 'pet accessories' })
    );
  });

  // S2 regression tests.
  it('marks the run FAILED and returns 503 (not an unhandled 500) when enqueueing fails', async () => {
    enqueueNicheHuntMock.mockRejectedValue(new Error('Redis connection refused'));

    const response = await POST(postRequest({ niche: 'pet accessories' }));
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(503);
    expect(body.error).not.toMatch(/Redis connection refused/);
    expect(updateRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run-1' },
        data: expect.objectContaining({ status: 'FAILED' }),
      })
    );
  });

  it('still returns 503 even if the best-effort FAILED update itself fails', async () => {
    enqueueNicheHuntMock.mockRejectedValue(new Error('Redis connection refused'));
    updateRunMock.mockRejectedValue(new Error('DB unreachable'));

    const response = await POST(postRequest({ niche: 'pet accessories' }));

    expect(response.status).toBe(503);
  });
});
