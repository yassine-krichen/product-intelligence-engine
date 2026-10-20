import { z } from 'zod';
import type { TrendPoint } from '@/features/scoring/trend-series';

/**
 * Thin client for Google's unofficial Trends web endpoints (the same calls
 * the trends.google.com page makes). There is no official API and no key:
 * the flow is landing page (NID cookie) -> /api/explore (widget token) ->
 * /api/widgetdata/multiline (the weekly series). Live-verified 2026-10-04,
 * see README "Live source verification". Request pattern only is informed by
 * the MIT-licensed trendspyg / trends-checker projects (see REUSE.md); no
 * code was copied.
 *
 * Unofficial means it can break or throttle (HTTP 429) without notice, so
 * every failure is thrown as a typed error for the caller to surface as a
 * DEGRADED source, never papered over with made-up data.
 */
const LANDING_URL = 'https://trends.google.com/trends/?geo=US';
const EXPLORE_URL = 'https://trends.google.com/trends/api/explore';
const MULTILINE_URL = 'https://trends.google.com/trends/api/widgetdata/multiline';

/** Browser-like UA: Google serves the consent/blocked page to obvious bot UAs. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Live test ran 7 requests at 2s spacing with no throttling; 3s keeps a safety margin and stays polite. */
export const MIN_REQUEST_INTERVAL_MS = 3_000;
/** The NID cookie lives for months; reusing it for an hour avoids a landing-page request per series. */
const COOKIE_TTL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
/** Only transient failures (5xx, network) are retried, once; a 429 is never hammered. */
const RETRY_DELAY_MS = 2_000;
const MAX_RETRIES = 1;
/** Fixed lookback: 5 years of weekly points gives enough history for seasonality detection. */
const TIME_RANGE = 'today 5-y';
const MAX_KEYWORD_LENGTH = 100;

const GEO_PATTERN = /^([A-Z]{2})?$/;
const XSSI_PREFIX = /^\)\]\}',?\n/;

export class TrendsRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message);
    this.name = 'TrendsRequestError';
  }
}

export class TrendsRateLimitedError extends TrendsRequestError {
  constructor() {
    super('Google Trends rate-limited this client (HTTP 429). Retry later.', 429);
    this.name = 'TrendsRateLimitedError';
  }
}

const ExploreResponseSchema = z.object({
  widgets: z.array(
    z.object({
      id: z.string(),
      token: z.string(),
      request: z.unknown(),
    })
  ),
});

const MultilineResponseSchema = z.object({
  default: z.object({
    timelineData: z.array(
      z.object({
        // Unix seconds, serialized as a string.
        time: z.string().regex(/^\d{9,11}$/),
        value: z.array(z.number()).min(1),
        isPartial: z.boolean().optional(),
      })
    ),
  }),
});

export interface TrendSeries {
  keyword: string;
  geo: string;
  points: TrendPoint[];
  fetchedAt: Date;
  /** Human-openable Google Trends page for the same query. */
  url: string;
}

export interface GoogleTrendsClientDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
}

export function buildExploreUrl(keyword: string, geo: string): string {
  const url = new URL('https://trends.google.com/trends/explore');
  url.searchParams.set('date', TIME_RANGE);
  url.searchParams.set('q', keyword);
  if (geo) url.searchParams.set('geo', geo);
  return url.toString();
}

/** Google's JSON is XSSI-prefixed; a changed shape means the unofficial endpoint moved and must surface as an error. */
function parseBody<T>(schema: z.ZodType<T>, body: string): T {
  try {
    return schema.parse(JSON.parse(body.replace(XSSI_PREFIX, '')));
  } catch {
    throw new TrendsRequestError('Google Trends returned an unexpected response shape.', null);
  }
}

export class GoogleTrendsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minIntervalMs: number;
  private lastRequestAt = 0;
  private cookie: { value: string; fetchedAt: number } | null = null;

  constructor(deps: GoogleTrendsClientDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.minIntervalMs = deps.minIntervalMs ?? MIN_REQUEST_INTERVAL_MS;
  }

  /** Weekly interest series for a keyword. Throws TrendsRequestError / TrendsRateLimitedError on any failure. */
  async fetchInterestOverTime(keyword: string, geo = ''): Promise<TrendSeries> {
    const cleanKeyword = keyword.trim();
    if (cleanKeyword.length === 0 || cleanKeyword.length > MAX_KEYWORD_LENGTH) {
      throw new TrendsRequestError(`Keyword must be 1-${MAX_KEYWORD_LENGTH} characters.`, null);
    }
    if (!GEO_PATTERN.test(geo)) {
      throw new TrendsRequestError('Geo must be an empty string or a two-letter uppercase country code.', null);
    }

    const widget = await this.exploreTimeseriesWidget(cleanKeyword, geo);
    const body = await this.request(
      `${MULTILINE_URL}?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(widget.request))}&token=${encodeURIComponent(widget.token)}`
    );
    const parsed = parseBody(MultilineResponseSchema, body);

    // Google flags the in-progress week as partial; it understates interest, so it would fake a decline.
    const points = parsed.default.timelineData
      .filter((row) => row.isPartial !== true)
      .map((row): TrendPoint => ({
        date: new Date(Number(row.time) * 1000),
        value: row.value[0]!,
      }));

    return {
      keyword: cleanKeyword,
      geo,
      points,
      fetchedAt: new Date(this.now()),
      url: buildExploreUrl(cleanKeyword, geo),
    };
  }

  /** Cheapest end-to-end probe: landing cookie + explore for a fixed keyword, no series fetch. */
  async probe(): Promise<void> {
    await this.exploreTimeseriesWidget('test', '');
  }

  private async exploreTimeseriesWidget(
    keyword: string,
    geo: string
  ): Promise<{ token: string; request: unknown }> {
    const exploreRequest = {
      comparisonItem: [{ keyword, geo, time: TIME_RANGE }],
      category: 0,
      property: '',
    };
    const body = await this.request(
      `${EXPLORE_URL}?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(exploreRequest))}`
    );
    const parsed = parseBody(ExploreResponseSchema, body);
    const widget = parsed.widgets.find((candidate) => candidate.id === 'TIMESERIES');
    if (!widget) {
      throw new TrendsRequestError('Google Trends explore response had no TIMESERIES widget.', null);
    }
    return widget;
  }

  private async ensureCookie(): Promise<string> {
    if (this.cookie && this.now() - this.cookie.fetchedAt < COOKIE_TTL_MS) {
      return this.cookie.value;
    }
    const response = await this.throttledFetch(LANDING_URL, '');
    if (!response.ok) {
      throw new TrendsRequestError(`Google Trends landing page returned HTTP ${response.status}.`, response.status);
    }
    const value = (response.headers.getSetCookie?.() ?? [])
      .map((cookie) => cookie.split(';')[0]!)
      .join('; ');
    this.cookie = { value, fetchedAt: this.now() };
    return value;
  }

  private async request(url: string): Promise<string> {
    const cookie = await this.ensureCookie();

    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.throttledFetch(url, cookie);
        if (response.status === 429) throw new TrendsRateLimitedError();
        if (!response.ok) {
          throw new TrendsRequestError(`Google Trends returned HTTP ${response.status}.`, response.status);
        }
        return await response.text();
      } catch (error) {
        const typed =
          error instanceof TrendsRequestError
            ? error
            : new TrendsRequestError(
                `Google Trends request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
                null
              );
        // Network failures (status null) and 5xx are transient; 429 and other 4xx are not.
        const retryable =
          !(typed instanceof TrendsRateLimitedError) && (typed.status === null || typed.status >= 500);
        if (!retryable || attempt >= MAX_RETRIES) throw typed;
        await this.sleep(RETRY_DELAY_MS);
      }
    }
  }

  private async throttledFetch(url: string, cookie: string): Promise<Response> {
    const wait = this.lastRequestAt + this.minIntervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();

    try {
      return await this.fetchImpl(url, {
        headers: { 'user-agent': USER_AGENT, ...(cookie ? { cookie } : {}) },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new TrendsRequestError(
        `Google Trends request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        null
      );
    }
  }
}

export const googleTrendsClient = new GoogleTrendsClient();
