/**
 * Basic in-memory token bucket.
 *
 * Phase 1 / single-tenant note (spec section 18, code-review finding S1):
 * this deployment has no reverse proxy and no authenticated users yet, so
 * there is no caller identity that can't be spoofed by a plain fetch from
 * the browser. In particular `x-forwarded-for` is fully attacker-controlled
 * without a trusted proxy in front of this server and MUST NOT be used as a
 * rate-limit key — any caller can set it to a fresh value on every request
 * and get a fresh bucket every time. Until real per-user auth exists, this
 * limiter keys on a single fixed bucket shared by every caller (in effect:
 * "how many research runs can this whole local deployment start per
 * minute"). That's honest about what it actually protects — a single-tenant
 * local tool — rather than pretending a per-caller isolation it can't
 * provide. Replace with authenticated-user-based limiting before any
 * multi-user deployment.
 *
 * This is still a Phase 1 placeholder in other respects too: state lives in
 * process memory, so it resets on every deploy/restart and does not share
 * state across multiple server instances.
 */

interface Bucket {
  tokens: number;
  lastRefillAt: number;
  lastAccessAt: number;
}

const buckets = new Map<string, Bucket>();

const MAX_TOKENS = 5;
const REFILL_INTERVAL_MS = 60_000; // one token back per minute
// A bucket untouched for this long is guaranteed fully refilled anyway, so
// it carries no useful state — pruning it bounds memory growth even if this
// module is ever extended to key on more than one fixed identifier.
const STALE_ENTRY_MS = REFILL_INTERVAL_MS * MAX_TOKENS;

/** The single shared bucket key for this Phase 1 single-tenant deployment — see module doc comment above. */
export const GLOBAL_RATE_LIMIT_KEY = 'single-tenant';

function pruneStaleBuckets(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastAccessAt > STALE_ENTRY_MS) {
      buckets.delete(key);
    }
  }
}

export function isRateLimited(key: string): boolean {
  const now = Date.now();
  pruneStaleBuckets(now);

  const bucket = buckets.get(key) ?? { tokens: MAX_TOKENS, lastRefillAt: now, lastAccessAt: now };

  const elapsed = now - bucket.lastRefillAt;
  const tokensToAdd = Math.floor(elapsed / REFILL_INTERVAL_MS);
  if (tokensToAdd > 0) {
    bucket.tokens = Math.min(MAX_TOKENS, bucket.tokens + tokensToAdd);
    bucket.lastRefillAt = now;
  }
  bucket.lastAccessAt = now;

  if (bucket.tokens <= 0) {
    buckets.set(key, bucket);
    return true;
  }

  bucket.tokens -= 1;
  buckets.set(key, bucket);
  return false;
}
