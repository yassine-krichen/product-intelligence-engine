import type { SourceId } from './source.types';

/** Query parameters that identify a campaign or click, not a page: two URLs differing only by these are one URL. */
const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i;

function parseHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** Lowercased hostname without a leading `www.`; null for anything that is not an http(s) URL. */
export function hostOf(raw: string): string | null {
  const url = parseHttpUrl(raw);
  return url ? url.hostname.toLowerCase().replace(/^www\./, '') : null;
}

/**
 * Canonical form used to decide whether two evidence rows cite the same page:
 * scheme, `www.`, fragment, trailing slash, default port, tracking parameters
 * and parameter order are all ignored. Null for a non-http(s) URL.
 */
export function normalizeUrl(raw: string): string | null {
  const url = parseHttpUrl(raw);
  if (!url) return null;

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const port = url.port ? `:${url.port}` : '';
  const path = url.pathname.replace(/\/+$/, '');
  const params = [...url.searchParams]
    .filter(([key]) => !TRACKING_PARAM.test(key))
    .sort(([a, aValue], [b, bValue]) => (a === b ? aValue.localeCompare(bValue) : a.localeCompare(b)));
  const query = new URLSearchParams(params).toString();

  return `${host}${port}${path}${query ? `?${query}` : ''}`;
}

function isDomainOrSubdomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** amazon.com, amazon.co.uk, amazon.com.au, amazon.de ... but never amazon.evil.com or notamazon.com. */
const AMAZON_HOST = /(^|\.)amazon\.(com?(\.[a-z]{2})?|co\.[a-z]{2}|[a-z]{2,3})$/;

/**
 * A declared source must match the URL's host, otherwise a label like
 * AMAZON_MOVERS_SHAKERS could be pinned on a Reddit page and count as an
 * independent source. WEB is the catch-all and accepts any host.
 */
export function hostMatchesSource(source: SourceId, raw: string): boolean {
  const host = hostOf(raw);
  if (host === null) return false;

  switch (source) {
    case 'WEB':
      return true;
    case 'REDDIT':
      return isDomainOrSubdomain(host, 'reddit.com');
    case 'AMAZON':
    case 'AMAZON_MOVERS_SHAKERS':
      return AMAZON_HOST.test(host);
    case 'TIKTOK':
    case 'TIKTOK_CREATIVE_CENTER':
      return isDomainOrSubdomain(host, 'tiktok.com');
    case 'GOOGLE_TRENDS':
      return host === 'trends.google.com';
    case 'HACKER_NEWS':
      return host === 'news.ycombinator.com' || host === 'hn.algolia.com';
    case 'ALIEXPRESS':
      return /(^|\.)aliexpress\.[a-z]{2,3}$/.test(host);
  }
}

/** True when one host is the other or a subdomain of it (old.reddit.com vs reddit.com). */
export function hostsRelated(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}
