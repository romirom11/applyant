// LinkedIn's job search as a source (phase 14): its search page under the candidate's session,
// read by a listing recipe inside the platform guardrails (readers/platform.ts). The selectors
// cover both the signed-in result list (job cards) and the public one (base cards); they were
// written from the page's known markup and are checked only against local fixture pages, never
// against linkedin.com by the tests. A stored recipe for the source replaces them when the
// markup changes.
import type { PlatformSearch } from './platform.ts';
import { placeOf, wantsRemote } from './platform.ts';

const ORIGIN = 'https://www.linkedin.com';

export const LINKEDIN: PlatformSearch = {
  platform: 'linkedin',
  searchUrl(query, locations) {
    const u = new URL('/jobs/search/', ORIGIN);
    u.searchParams.set('keywords', query);
    const place = placeOf(locations);
    if (place) u.searchParams.set('location', place);
    // Remote (f_WT=2) and posted in the last week (f_TPR): what a person would filter to.
    if (wantsRemote(locations)) u.searchParams.set('f_WT', '2');
    u.searchParams.set('f_TPR', 'r604800');
    return u.toString();
  },
  recipe: {
    kind: 'locators',
    list: null,
    item: {
      css: 'li[data-occludable-job-id], li.jobs-search-results__list-item, ul.jobs-search__results-list > li, div.job-card-container',
    },
    fields: {
      title: {
        css: '.job-card-list__title, .job-card-container__link strong, .base-search-card__title, a[href*="/jobs/view/"]',
      },
      url: { css: 'a[href*="/jobs/view/"], a[href*="currentJobId="]' },
      location: {
        css: '.job-card-container__metadata-item, .artdeco-entity-lockup__caption, .job-search-card__location',
      },
      team: null,
    },
    pagination: null,
  },
  company:
    '.artdeco-entity-lockup__subtitle, .job-card-container__primary-description, .base-search-card__subtitle',
  jobPage: linkedinJobPage,
};

/** `/jobs/view/<id>` (or a search page's `currentJobId=<id>`) → the job's own page. */
export function linkedinJobPage(url: string): { url: string; id: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
  const id =
    /\/jobs\/view\/(?:[^/]*-)?(\d{6,})\/?/.exec(u.pathname)?.[1] ??
    (/^\d{6,}$/.test(u.searchParams.get('currentJobId') ?? '')
      ? u.searchParams.get('currentJobId')
      : null);
  return id ? { url: `${ORIGIN}/jobs/view/${id}/`, id } : null;
}
