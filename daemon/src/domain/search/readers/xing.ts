// Xing's job search as a source (phase 14): its search page under the candidate's session, read
// by a listing recipe inside the platform guardrails (readers/platform.ts). The selectors were
// written from the page's known markup and are checked only against local fixture pages, never
// against xing.com by the tests; a stored recipe for the source replaces them when it changes.
import type { PlatformSearch } from './platform.ts';
import { placeOf, wantsRemote } from './platform.ts';

const ORIGIN = 'https://www.xing.com';

export const XING: PlatformSearch = {
  platform: 'xing',
  searchUrl(query, locations) {
    const u = new URL('/jobs/search', ORIGIN);
    u.searchParams.set('keywords', query);
    const place = placeOf(locations);
    if (place) u.searchParams.set('location', place);
    if (wantsRemote(locations)) u.searchParams.set('remoteOption', 'FULLY_REMOTE');
    return u.toString();
  },
  recipe: {
    kind: 'locators',
    list: null,
    item: {
      css: 'article[data-testid="job-search-result"], li[data-testid="job-search-result"], article[class*="job-teaser"]',
    },
    fields: {
      title: { css: '[data-testid="job-teaser-list-title"], h2, h3' },
      url: { css: 'a[href*="/jobs/"]' },
      location: { css: '[data-testid="job-teaser-list-location"], [class*="location" i]' },
      team: null,
    },
    pagination: null,
  },
  company: '[data-testid="job-teaser-list-company"], [class*="company" i]',
  jobPage: xingJobPage,
};

/** `/jobs/<city>-<title>-<id>` → the job's own page. */
export function xingJobPage(url: string): { url: string; id: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)xing\.com$/i.test(u.hostname)) return null;
  const m = /^\/jobs\/([a-z0-9-]*?-)?(\d{5,})\/?$/i.exec(u.pathname);
  if (!m?.[2]) return null;
  return { url: `${ORIGIN}${u.pathname.replace(/\/$/, '')}`, id: m[2] };
}
