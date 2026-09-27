import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { enqueueNicheHunt } from '@/features/jobs/queue';
import { GLOBAL_RATE_LIMIT_KEY, isRateLimited } from '@/lib/rate-limit';
import { isAllowedSubreddit } from '@/features/discovery/adapters/reddit.adapter';

// Dynamic route handler — never statically generated. This calls Prisma and
// enqueues a job on every request, and must not be evaluated at
// `next build` time (spec: "next build must not require a live DATABASE_URL").
export const dynamic = 'force-dynamic';

// Same allowlist as reddit.adapter.ts — duplicated here deliberately so this
// route rejects a malformed subreddit name before the job is even enqueued,
// not just before the fetch happens deep in the adapter (spec section 18:
// "rejects malformed subreddit names before they ever reach a fetch").
const SUBREDDIT_ALLOWLIST = /^[A-Za-z0-9_]{2,21}$/;

const CreateResearchRunSchema = z.object({
  niche: z.string().trim().min(2, 'niche must be at least 2 characters').max(100),
  subreddits: z.array(z.string().regex(SUBREDDIT_ALLOWLIST)).max(10).optional(),
});

// S2 fix: an unreachable/slow Redis must never hang this request forever —
// enqueueing gets a hard timeout so the client gets a definite response.
const ENQUEUE_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // S1 fix: `x-forwarded-for` is fully client-spoofable without a trusted
  // reverse proxy in front of this server (there is none in this Phase 1
  // deployment) — trusting it as an identity key means every request can
  // simply claim a fresh IP and skip the limit entirely. See rate-limit.ts's
  // module doc comment for the accepted single-tenant tradeoff.
  if (isRateLimited(GLOBAL_RATE_LIMIT_KEY)) {
    return NextResponse.json(
      { error: 'Too many requests. Try again in a minute.' },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const parsed = CreateResearchRunSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input.', details: z.treeifyError(parsed.error) },
      { status: 400 }
    );
  }

  const { niche, subreddits = [] } = parsed.data;

  // Defense in depth: this loop is redundant with the Zod regex above, but
  // it guarantees no subreddit reaches enqueue/fetch without passing through
  // the same allowlist function the adapter itself uses.
  const rejected = subreddits.filter((subreddit) => !isAllowedSubreddit(subreddit));
  if (rejected.length > 0) {
    return NextResponse.json(
      { error: `Rejected subreddit name(s): ${rejected.join(', ')}` },
      { status: 400 }
    );
  }

  const run = await prisma.researchRun.create({
    data: {
      niche,
      subreddits,
      sources: ['REDDIT', 'HACKER_NEWS'],
      status: 'PENDING',
    },
  });

  // S2 fix: a failed/timed-out enqueue previously left the just-created run
  // stuck PENDING forever (nothing would ever pick it up) and bubbled up as
  // an unhandled 500. Mark it FAILED with the reason and return a definite
  // 503 instead.
  try {
    await withTimeout(
      enqueueNicheHunt({ runId: run.id, niche, subreddits }),
      ENQUEUE_TIMEOUT_MS,
      'Timed out enqueueing research run job (queue/Redis unreachable?).'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown enqueue error';
    await prisma.researchRun
      .update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          errors: [{ source: 'enqueue', message, occurredAt: new Date().toISOString() }],
        },
      })
      // Best-effort: the 503 below is the important signal either way: don't
      // let a second failure here mask the original enqueue error. Still log
      // it — a silently swallowed catch here would hide a run stuck PENDING
      // forever (no FAILED status ever recorded) with no trace anywhere.
      .catch((updateError: unknown) => {
        console.error('[research-runs] failed to record FAILED status after enqueue error', {
          runId: run.id,
          updateError,
        });
      });

    return NextResponse.json(
      { error: 'Failed to queue research run. Try again shortly.' },
      { status: 503 }
    );
  }

  return NextResponse.json({ id: run.id }, { status: 202 });
}
