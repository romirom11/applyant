// Running a listing recipe: plain Playwright, no model. Locator recipes find the list, its items
// and each item's title, link, location and team (ARIA roles first, CSS as the fallback), then
// follow the pagination; text-pattern recipes run one regex over the page's linked text.
//
// Every run is checked with cheap invariants (checkInvariants). A recipe's list is never
// complete: a posting missing from it is re-verified, never closed.
import type { Locator, Page } from 'playwright';
import { canonicalUrl } from '../canonical-url.ts';
import type { Listing, ReaderRun } from '../readers/types.ts';
import { linkedText, markHidden } from './page.ts';
import type { ListingRecipe, LocatorSpec, RecipeListing } from './types.ts';

/** Items read from one page (a huge page is more likely a mis-aimed recipe than a job list). */
export const MAX_ITEMS = 500;
/** "Next" pages followed. */
export const MAX_PAGES = 10;
/** Scrolls tried for infinite lists, and how many in a row may add nothing before stopping. */
export const MAX_SCROLLS = 30;
export const EMPTY_SCROLLS_TO_STOP = 3;
/** The count window [0.3 × last, 3 × last] applies only once the last good read had this many. */
export const COUNT_WINDOW_FROM = 5;

type AriaRole = Parameters<Page['getByRole']>[0];

export function locate(scope: Page | Locator, spec: LocatorSpec): Locator {
  if ('css' in spec) return scope.locator(spec.css);
  return scope.getByRole(spec.role as AriaRole, spec.name ? { name: spec.name } : {});
}

const clean = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();

async function textOf(l: Locator): Promise<string | null> {
  if ((await l.count()) === 0) return null;
  const t = clean(await l.innerText({ timeout: 2_000 }).catch(() => ''));
  return t || null;
}

/** The link an element is, is inside, or holds. */
async function hrefOf(l: Locator): Promise<string | null> {
  if ((await l.count()) === 0) return null;
  return l
    .evaluate((el) => {
      const a =
        (el.closest('a[href]') as HTMLAnchorElement | null) ??
        (el.querySelector('a[href]') as HTMLAnchorElement | null);
      return a ? a.href : el.getAttribute('href');
    }, undefined)
    .catch(() => null);
}

function absolute(href: string | null, base: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Every visible item of every list the recipe names, read in order. */
async function readItems(
  page: Page,
  r: Extract<ListingRecipe, { kind: 'locators' }>,
  seen: Set<string>,
): Promise<RecipeListing[]> {
  const out: RecipeListing[] = [];
  const scopes = r.list ? await locate(page, r.list).filter({ visible: true }).all() : [page];
  for (const scope of scopes) {
    const items = await locate(scope, r.item).filter({ visible: true }).all();
    for (const item of items) {
      if (seen.size >= MAX_ITEMS) return out;
      const titleEl = locate(item, r.fields.title).first();
      const title = await textOf(titleEl);
      if (!title) continue;
      const href = r.fields.url
        ? await hrefOf(locate(item, r.fields.url).first())
        : ((await hrefOf(titleEl)) ?? (await hrefOf(item)));
      const url = absolute(href, page.url());
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({
        title,
        url,
        location: r.fields.location ? await textOf(locate(item, r.fields.location).first()) : null,
        team: r.fields.team ? await textOf(locate(item, r.fields.team).first()) : null,
      });
    }
  }
  return out;
}

async function settle(page: Page, ms: number): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {});
}

/**
 * The first item's title and link: what changes when a page turns. Null while the list shows
 * no item (a list being reloaded). Not the page's URL: lists that turn in place often push
 * ?page=2 into it at once, before the new items arrive.
 */
async function signature(
  page: Page,
  r: Extract<ListingRecipe, { kind: 'locators' }>,
): Promise<string | null> {
  const scope = r.list ? locate(page, r.list).filter({ visible: true }).first() : page;
  const item = locate(scope, r.item).filter({ visible: true }).first();
  if ((await item.count()) === 0) return null;
  const title = locate(item, r.fields.title).first();
  const text = await textOf(title);
  if (!text) return null;
  return `${(await hrefOf(title)) ?? ''}|${text}`;
}

/** How long a "next" press may take to show the next page (in place or by navigation). */
const PAGE_TURN_MS = 10_000;

export interface RecipeResult {
  listings: RecipeListing[];
  /** The first page's listings (what a fixture holds). */
  firstPage: RecipeListing[];
  pages: number;
  scrolls: number;
  /** Why pagination stopped, when it ran. */
  stop: string | null;
}

export interface RunOptions {
  /** Follow "next" / scroll (false for fixtures: the next page isn't stored). */
  paginate: boolean;
  signal?: AbortSignal;
  /** Between scrolls (tests shorten it). */
  scrollWaitMs?: number;
}

/** Runs a recipe on an open page. */
export async function runRecipe(
  page: Page,
  recipe: ListingRecipe,
  o: RunOptions,
): Promise<RecipeResult> {
  if (recipe.kind === 'textPattern') {
    const listings = await runTextPattern(page, recipe);
    return { listings, firstPage: listings, pages: 1, scrolls: 0, stop: null };
  }
  const seen = new Set<string>();
  const firstPage = await readItems(page, recipe, seen);
  const listings = [...firstPage];
  let pages = 1;
  let scrolls = 0;
  let stop: string | null = null;
  const p = recipe.pagination;
  if (o.paginate && p && 'next' in p) {
    for (;;) {
      o.signal?.throwIfAborted();
      if (pages >= MAX_PAGES) {
        stop = `stopped after ${MAX_PAGES} pages`;
        break;
      }
      if (seen.size >= MAX_ITEMS) {
        stop = `stopped at ${MAX_ITEMS} jobs`;
        break;
      }
      const next = locate(page, p.next).filter({ visible: true }).first();
      if ((await next.count()) === 0) {
        stop = 'no next page';
        break;
      }
      const disabled = await next
        .evaluate(
          (el) =>
            (el as HTMLButtonElement).disabled === true ||
            el.getAttribute('aria-disabled') === 'true',
          undefined,
        )
        .catch(() => true);
      if (disabled) {
        stop = 'next page disabled';
        break;
      }
      const before = await signature(page, recipe);
      await next.click({ timeout: 5_000 });
      // Many lists turn the page in place a moment after the click (often through an empty or
      // loading list): wait until a different first item shows, or a navigation, not just for
      // the network to go quiet.
      await page.waitForLoadState('domcontentloaded', { timeout: PAGE_TURN_MS }).catch(() => {});
      const deadline = Date.now() + PAGE_TURN_MS;
      for (;;) {
        o.signal?.throwIfAborted();
        const now = await signature(page, recipe).catch(() => null);
        if ((now !== null && now !== before) || Date.now() >= deadline) break;
        await page.waitForTimeout(250);
      }
      await settle(page, 3_000);
      const more = await readItems(page, recipe, seen);
      pages++;
      if (more.length === 0) {
        stop = 'the next page added nothing';
        break;
      }
      listings.push(...more);
    }
  } else if (o.paginate && p && 'scroll' in p) {
    let empty = 0;
    while (scrolls < MAX_SCROLLS && seen.size < MAX_ITEMS) {
      o.signal?.throwIfAborted();
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      scrolls++;
      await page.waitForTimeout(o.scrollWaitMs ?? 1_000);
      await settle(page, 3_000);
      const more = await readItems(page, recipe, seen);
      listings.push(...more);
      empty = more.length === 0 ? empty + 1 : 0;
      if (empty >= EMPTY_SCROLLS_TO_STOP) {
        stop = `${EMPTY_SCROLLS_TO_STOP} scrolls in a row added nothing`;
        break;
      }
    }
    stop ??= `stopped after ${scrolls} scrolls`;
  }
  return { listings, firstPage, pages, scrolls, stop };
}

/**
 * A text pattern runs inside the page, not in the daemon: a pattern that backtracks forever
 * hangs a throwaway browser page (the task's abort closes it), never applyantd.
 */
async function runTextPattern(
  page: Page,
  r: Extract<ListingRecipe, { kind: 'textPattern' }>,
): Promise<RecipeListing[]> {
  await markHidden(page);
  const text = await linkedText(page);
  const flags = r.flags.includes('g') ? r.flags : `${r.flags}g`;
  const matches = await page.evaluate(
    ({ text, pattern, flags, max }) => {
      const out: Array<Array<string | null>> = [];
      for (const m of text.matchAll(new RegExp(pattern, flags))) {
        out.push(Array.from(m, (g) => g ?? null));
        if (out.length >= max) break;
      }
      return out;
    },
    { text, pattern: r.pattern, flags, max: MAX_ITEMS },
  );
  const seen = new Set<string>();
  const out: RecipeListing[] = [];
  for (const m of matches) {
    const title = clean(m[r.groups.title]);
    const url = absolute(r.groups.url !== null ? (m[r.groups.url] ?? null) : null, page.url());
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title,
      url,
      location: r.groups.location !== null ? clean(m[r.groups.location]) || null : null,
      team: null,
    });
  }
  return out;
}

// ---- Invariants ---------------------------------------------------------------------------

/** Hosts of applicant tracking systems a career page may link its jobs to. */
export const KNOWN_ATS_HOSTS = [
  'greenhouse.io',
  'ashbyhq.com',
  'lever.co',
  'workable.com',
  'myworkdayjobs.com',
  'myworkdaysite.com',
  'workday.com',
  'smartrecruiters.com',
  'recruitee.com',
  'personio.de',
  'personio.com',
  'teamtailor.com',
  'bamboohr.com',
  'jobvite.com',
  'icims.com',
  'breezy.hr',
  'homerun.co',
  'join.com',
  'pinpointhq.com',
  'rippling.com',
  'dover.com',
  'gem.com',
  'jazzhr.com',
  'applytojob.com',
  'zohorecruit.com',
  'zohorecruit.eu',
  'successfactors.com',
  'successfactors.eu',
  'taleo.net',
  'oraclecloud.com',
  'eightfold.ai',
  'comeet.com',
  'comeet.co',
  'softgarden.io',
  'factorialhr.com',
  'kenjo.io',
  'hibob.com',
  'welcometothejungle.com',
  'recruitcrm.io',
  'freshteam.com',
  'trakstar.com',
  'polymer.co',
];

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ltd', 'plc']);

/** The registrable part of a host ("careers.acme.co.uk" → "acme.co.uk"), approximately. */
export function siteOf(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const last = labels.at(-1) ?? '';
  const second = labels.at(-2) ?? '';
  const n = last.length === 2 && SECOND_LEVEL.has(second) ? 3 : 2;
  return labels.slice(-n).join('.');
}

function onKnownAts(host: string): boolean {
  const h = host.toLowerCase();
  return KNOWN_ATS_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

export interface InvariantInput {
  listings: RecipeListing[];
  /** The page the recipe ran on. */
  pageUrl: string;
  /** Listings of the last good read; null when there was none. */
  lastCount: number | null;
}

/** What's wrong with a recipe's output; [] when it can be trusted. */
export function checkInvariants(i: InvariantInput): string[] {
  const problems: string[] = [];
  const { listings } = i;
  let pageSite: string | null = null;
  try {
    pageSite = siteOf(new URL(i.pageUrl).hostname);
  } catch {
    // An unparseable page URL: the link check below can't compare hosts.
  }
  const offsite: string[] = [];
  const bad: string[] = [];
  for (const l of listings) {
    let u: URL;
    try {
      u = new URL(l.url);
    } catch {
      bad.push(l.url);
      continue;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      bad.push(l.url);
      continue;
    }
    if (pageSite && siteOf(u.hostname) !== pageSite && !onKnownAts(u.hostname)) offsite.push(l.url);
  }
  if (bad.length) problems.push(`${bad.length} link(s) aren't absolute web addresses (${bad[0]})`);
  if (offsite.length) {
    problems.push(`${offsite.length} link(s) lead off the site to an unknown host (${offsite[0]})`);
  }
  const empty = listings.filter((l) => !l.title.trim()).length;
  if (empty) problems.push(`${empty} listing(s) have no title`);
  if (listings.length >= 2) {
    const titles = new Set(listings.map((l) => l.title.trim().toLowerCase()));
    if (titles.size === 1)
      problems.push(`every listing has the same title ("${listings[0]?.title}")`);
    const urls = new Set(listings.map((l) => l.url));
    if (urls.size === 1)
      problems.push(`every listing links to the same page (${listings[0]?.url})`);
  }
  if (i.lastCount !== null && i.lastCount >= COUNT_WINDOW_FROM) {
    const n = listings.length;
    if (n < 0.3 * i.lastCount || n > 3 * i.lastCount) {
      problems.push(`${n} listings where the last good read had ${i.lastCount}`);
    }
  }
  return problems;
}

/** A recipe's listings as the search pipeline's listings (never a complete list). */
export function toReaderRun(listings: RecipeListing[], note: string): ReaderRun {
  return {
    listings: listings.map(
      (l): Listing => ({
        url: l.url,
        sourceUrl: l.url,
        externalId: canonicalOrSelf(l.url),
        title: l.title,
        company: null,
        location: l.location,
        remote: l.location ? /\b(remote|anywhere|worldwide)\b/i.test(l.location) || null : null,
        team: l.team,
        description: null,
        applyUrl: null,
        postedAt: null,
      }),
    ),
    complete: false,
    note,
  };
}

function canonicalOrSelf(url: string): string {
  try {
    return canonicalUrl(url);
  } catch {
    return url;
  }
}
