import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('isRateLimited', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows the first MAX_TOKENS requests for a key, then rejects', async () => {
    vi.resetModules();
    const { isRateLimited } = await import('./rate-limit');
    const key = `test-key-${Math.random()}`;

    for (let i = 0; i < 5; i++) {
      expect(isRateLimited(key)).toBe(false);
    }
    expect(isRateLimited(key)).toBe(true);
  });

  it('refills one token per minute', async () => {
    vi.resetModules();
    const { isRateLimited } = await import('./rate-limit');
    const key = `test-key-${Math.random()}`;

    for (let i = 0; i < 5; i++) isRateLimited(key);
    expect(isRateLimited(key)).toBe(true);

    vi.advanceTimersByTime(60_000);
    expect(isRateLimited(key)).toBe(false);
  });

  it('keeps two different keys independent', async () => {
    vi.resetModules();
    const { isRateLimited } = await import('./rate-limit');
    const keyA = `a-${Math.random()}`;
    const keyB = `b-${Math.random()}`;

    for (let i = 0; i < 5; i++) isRateLimited(keyA);
    expect(isRateLimited(keyA)).toBe(true);
    // A separate key must not be affected by a different key's usage.
    expect(isRateLimited(keyB)).toBe(false);
  });

  it('exports a stable GLOBAL_RATE_LIMIT_KEY (S1: single-tenant, not per-IP)', async () => {
    vi.resetModules();
    const { GLOBAL_RATE_LIMIT_KEY } = await import('./rate-limit');

    expect(typeof GLOBAL_RATE_LIMIT_KEY).toBe('string');
    expect(GLOBAL_RATE_LIMIT_KEY.length).toBeGreaterThan(0);
  });
});
