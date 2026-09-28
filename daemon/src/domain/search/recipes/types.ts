// Listing recipes: how to read a job list from a page that has no feed and no known ATS embed.
// `reader_builder` writes one once per board; every later read runs it as plain Playwright.
// Recipes cover the list only (title, link, location, team, pagination): the posting text is
// read at verification, like any other posting's.

/** How to find elements: an ARIA role with an accessible name (preferred), or CSS. */
export type LocatorSpec = { role: string; name: string | null } | { css: string };

export type ListingRecipe =
  | {
      kind: 'locators';
      /** The container of the job list; null = the whole page. */
      list: LocatorSpec | null;
      /** One job, inside the list. */
      item: LocatorSpec;
      fields: {
        /** Inside the item: the job's title (its text). */
        title: LocatorSpec;
        /** Inside the item: the element whose link is the job's page; null = the title's link. */
        url: LocatorSpec | null;
        location: LocatorSpec | null;
        team: LocatorSpec | null;
      };
      pagination: { next: LocatorSpec } | { scroll: true } | null;
    }
  | {
      kind: 'textPattern';
      /**
       * A regex over the page's linked text (its visible text, with every link's address after
       * its text as ` <https://…>`), one match per job.
       */
      pattern: string;
      flags: string;
      groups: { title: number; url: number | null; location: number | null };
    };

/** One job as a recipe reads it. */
export interface RecipeListing {
  title: string;
  /** Absolute. */
  url: string;
  location: string | null;
  team: string | null;
}

/**
 * ok: verified and in use · building: a build is queued or running (the page had no way to be
 * read, or its recipe failed its checks) · failed: no recipe could be built; tried again later.
 */
export const RECIPE_STATUSES = ['ok', 'building', 'failed'] as const;
export type RecipeStatus = (typeof RECIPE_STATUSES)[number];

export function describeLocator(l: LocatorSpec | null): string {
  if (!l) return '-';
  if ('css' in l) return `css ${l.css}`;
  return l.name ? `${l.role} "${l.name}"` : l.role;
}

/** One line per part, for the CLI and the builder's second attempt. */
export function describeRecipe(r: ListingRecipe): string[] {
  if (r.kind === 'textPattern') {
    return [
      `text pattern /${r.pattern}/${r.flags}`,
      `groups: title ${r.groups.title} · url ${r.groups.url ?? '-'} · location ${r.groups.location ?? '-'}`,
    ];
  }
  const pagination = !r.pagination
    ? 'none'
    : 'scroll' in r.pagination
      ? 'scroll to load more'
      : `next: ${describeLocator(r.pagination.next)}`;
  return [
    `list ${describeLocator(r.list)} → item ${describeLocator(r.item)}`,
    `title ${describeLocator(r.fields.title)} · link ${r.fields.url ? describeLocator(r.fields.url) : "the title's link"} · location ${describeLocator(r.fields.location)} · team ${describeLocator(r.fields.team)}`,
    `pagination ${pagination}`,
  ];
}
