import { describe, expect, it, vi } from 'vitest';
import {
  GoogleTrendsClient,
  TrendsRateLimitedError,
  TrendsRequestError,
  buildExploreUrl,
} from './google-trends.client';

const XSSI = ")]}'\n";

function exploreBody(): string {
  return `${XSSI}${JSON.stringify({
    widgets: [
      { id: 'RELATED_QUERIES', token: 'x', request: {} },
      { id: 'TIMESERIES', token: 'tok123', request: { time: '2021-10-04 2026-10-04' } },
    ],
  })}`;
}

function multilineBody(rows: Array<{ time: number; value: number; isPartial?: boolean }>): string {
  return `${XSSI}${JSON.stringify({
    default: {
      timelineData: rows.map((r) => ({
        time: String(r.time),
        value: [r.value],
        ...(r.isPartial ? { isPartial: true } : {}),
      })),
    },
  })}`;
}

function response(body: string, init: { status?: number; cookies?: string[] } = {}): Response {
  const headers = new Headers();
  for (const cookie of init.cookies ?? []) headers.append('set-cookie', cookie);
  return new Response(body, { status: init.status ?? 200, headers });
}

/** A scripted fetch: landing page, explore, multiline, in order of the URL hit. */
function scriptedFetch(overrides: Partial<Record<'landing' | 'explore' | 'multiline', () => Response>> = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/api/explore')) return (overrides.explore ?? (() => response(exploreBody())))();
    if (url.includes('/widgetdata/multiline')) {
      return (overrides.multiline ??
        (() =>
          response(
            multilineBody([
              { time: 1_633_219_200, value: 10 },
              { time: 1_633_824_000, value: 20 },
              { time: 1_634_428_800, value: 99, isPartial: true },
            ])
          )))();
    }
    return (overrides.landing ?? (() => response('<html></html>', { cookies: ['NID=abc; Path=/'] })))();
  });
}

function makeClient(fetchImpl: typeof fetch, extra: { minIntervalMs?: number } = {}) {
  let clock = 1_000_000;
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const client = new GoogleTrendsClient({ fetchImpl, now: () => clock, sleep, ...extra });
  return { client, sleep };
}

describe('GoogleTrendsClient.fetchInterestOverTime', () => {
  it('returns weekly points, drops the partial in-progress week, and builds a verifiable URL', async () => {
    const fetchImpl = scriptedFetch();
    const { client } = makeClient(fetchImpl as unknown as typeof fetch);

    const series = await client.fetchInterestOverTime('pickleball paddle', 'US');

    expect(series.points.map((p) => p.value)).toEqual([10, 20]);
    expect(series.points[0]!.date.toISOString()).toBe('2021-10-03T00:00:00.000Z');
    expect(series.url).toBe(buildExploreUrl('pickleball paddle', 'US'));
    expect(series.url).toContain('geo=US');
  });

  it('sends the cookie from the landing page and the keyword only as an encoded query value', async () => {
    const fetchImpl = scriptedFetch();
    const { client } = makeClient(fetchImpl as unknown as typeof fetch);

    await client.fetchInterestOverTime('a&b=c"} injected', '');

    const exploreCall = fetchImpl.mock.calls.find(([u]) => String(u).includes('/api/explore'))!;
    const url = new URL(String(exploreCall[0]));
    expect(url.hostname).toBe('trends.google.com');
    expect(url.searchParams.get('req')).toContain('a&b=c\\"} injected');
    expect(((exploreCall as unknown[])[1] as RequestInit).headers).toMatchObject({ cookie: 'NID=abc' });
  });

  it('spaces requests by the minimum interval', async () => {
    const fetchImpl = scriptedFetch();
    const { client, sleep } = makeClient(fetchImpl as unknown as typeof fetch, { minIntervalMs: 3000 });

    await client.fetchInterestOverTime('x');

    // landing, explore, multiline: the second and third must each wait for the interval.
    expect(sleep.mock.calls.filter(([ms]) => ms > 0 && ms <= 3000).length).toBeGreaterThanOrEqual(2);
  });

  it('reuses the cookie for a second series instead of hitting the landing page again', async () => {
    const fetchImpl = scriptedFetch();
    const { client } = makeClient(fetchImpl as unknown as typeof fetch);

    await client.fetchInterestOverTime('one');
    await client.fetchInterestOverTime('two');

    const landingCalls = fetchImpl.mock.calls.filter(([u]) => !String(u).includes('/api/') && !String(u).includes('widgetdata'));
    expect(landingCalls).toHaveLength(1);
  });

  it('throws TrendsRateLimitedError on HTTP 429 and does not retry', async () => {
    const fetchImpl = scriptedFetch({ explore: () => response('', { status: 429 }) });
    const { client } = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.fetchInterestOverTime('x')).rejects.toBeInstanceOf(TrendsRateLimitedError);
    expect(fetchImpl.mock.calls.filter(([u]) => String(u).includes('/api/explore'))).toHaveLength(1);
  });

  it('retries a 5xx once, then fails with a typed error', async () => {
    const fetchImpl = scriptedFetch({ explore: () => response('', { status: 503 }) });
    const { client } = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.fetchInterestOverTime('x')).rejects.toMatchObject({ name: 'TrendsRequestError', status: 503 });
    expect(fetchImpl.mock.calls.filter(([u]) => String(u).includes('/api/explore'))).toHaveLength(2);
  });

  it('fails with a typed error, never fake data, when the response shape changes', async () => {
    const fetchImpl = scriptedFetch({ multiline: () => response(`${XSSI}{"unexpected":true}`) });
    const { client } = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.fetchInterestOverTime('x')).rejects.toThrow(/unexpected response shape/);
  });

  it('fails when the explore response has no TIMESERIES widget', async () => {
    const fetchImpl = scriptedFetch({ explore: () => response(`${XSSI}{"widgets":[]}`) });
    const { client } = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.fetchInterestOverTime('x')).rejects.toThrow(/TIMESERIES/);
  });

  it('wraps a network failure in TrendsRequestError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const { client } = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.fetchInterestOverTime('x')).rejects.toBeInstanceOf(TrendsRequestError);
  });

  it('rejects an empty/oversize keyword or a lowercase geo before any network call', async () => {
    const fetchImpl = scriptedFetch();
    const { client } = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.fetchInterestOverTime('   ')).rejects.toBeInstanceOf(TrendsRequestError);
    await expect(client.fetchInterestOverTime('k'.repeat(101))).rejects.toBeInstanceOf(TrendsRequestError);
    await expect(client.fetchInterestOverTime('x', 'us')).rejects.toBeInstanceOf(TrendsRequestError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
