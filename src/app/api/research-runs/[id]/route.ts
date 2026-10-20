import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

// Dynamic route handler — polled by the dashboard while a run is in
// progress, must reflect live DB state on every call.
export const dynamic = 'force-dynamic';

const MAX_ERROR_MESSAGE_LENGTH = 200;

const GENERIC_INTERNAL_ERROR_MESSAGE = 'Internal error (see server logs)';

interface ClientRunError {
  source: string;
  message: string;
  occurredAt: string;
}

/**
 * S7 fix: matches the shape of a raw Prisma client error message, e.g.
 * `` Invalid `prisma.demandObservation.create()` invocation in `` followed by
 * an absolute file path and `:line:col`. Also matches a bare absolute path
 * on its own (Windows `C:\...`/`\\server\share\...` or POSIX `/...`) — the
 * kind of detail that can otherwise ride along inside an otherwise
 * innocuous-looking message. Truncating alone (the previous approach) never
 * removed this: a 200-char slice of a Prisma error still contains the full
 * driver invocation and file path, just cut off before the end.
 *
 * The POSIX-path branch's lookbehind excludes a preceding `:` (in addition
 * to a word char or `/`) specifically so an ordinary `https://...`/`http://...`
 * URL inside a message — a normal, non-sensitive thing to appear in a source
 * adapter's error text — isn't misidentified as a leaked filesystem path.
 */
const INTERNAL_ERROR_SHAPE_PATTERN =
  /Invalid `prisma\.|[A-Za-z]:\\[^\s`]+|\\\\[^\s`]+|(?<![\w/:])\/(?:[^\s`]+\/)+[^\s`]+/;

/**
 * S7 fix: rather than trying to selectively find-and-redact every possible
 * internal detail inside a message (an ever-growing blocklist that's easy to
 * miss a case with), any message that matches a known internal-error shape
 * is replaced wholesale with a fixed, generic string. This is a strictly
 * stronger guarantee than partial redaction: no substring of the original
 * message survives, at the cost of losing detail the client never needed
 * anyway (it's still in the server logs / DB row).
 */
function sanitizeMessage(message: string): string {
  const collapsed = message.replace(/\s+/g, ' ').trim();
  if (INTERNAL_ERROR_SHAPE_PATTERN.test(collapsed)) {
    return GENERIC_INTERNAL_ERROR_MESSAGE;
  }
  return collapsed.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

/**
 * `errors` is a free-form Json column populated by internal try/catch blocks
 * across the pipeline/adapters/worker. Most of those messages are already
 * short and hand-written, but nothing enforces that — a raw Prisma or Zod
 * exception message (which can include schema paths, stack-adjacent detail,
 * or absolute file paths) must never reach a client response verbatim (spec
 * section 18). This keeps only a short, single-line, plain-text message per
 * entry — replacing it outright with a generic string when it matches a
 * known internal-error shape (see `sanitizeMessage`) — and drops anything
 * that doesn't look like the expected entry shape at all.
 */
function sanitizeRunError(entry: unknown): ClientRunError | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const { source, message, occurredAt } = entry as Record<string, unknown>;
  if (
    typeof source !== 'string' ||
    typeof message !== 'string' ||
    typeof occurredAt !== 'string'
  ) {
    return null;
  }

  return {
    source,
    message: sanitizeMessage(message),
    occurredAt,
  };
}

function sanitizeRunErrors(errors: unknown): ClientRunError[] {
  if (!Array.isArray(errors)) return [];
  return errors
    .map(sanitizeRunError)
    .filter((entry): entry is ClientRunError => entry !== null);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  // S7 fix: an explicit `select` — never the full row — so only
  // client-relevant fields are ever eligible to leave this endpoint, even if
  // an internal-only field is added to the model later.
  const run = await prisma.researchRun.findUnique({
    where: { id },
    select: {
      id: true,
      startedAt: true,
      finishedAt: true,
      sources: true,
      status: true,
      candidateCount: true,
      errors: true,
      niche: true,
      createdAt: true,
      candidates: {
        select: {
          id: true,
          canonicalName: true,
          niche: true,
          category: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  if (!run) {
    return NextResponse.json({ error: 'Research run not found.' }, { status: 404 });
  }

  return NextResponse.json({
    run: { ...run, errors: sanitizeRunErrors(run.errors) },
  });
}
