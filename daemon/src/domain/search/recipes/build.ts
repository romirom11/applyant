// build_recipe: a listing recipe for one page source, written once by reader_builder.
//
//   slow phase  open the page in the headless reader · capture it (ARIA snapshot, DOM outline,
//               linked text, and the HTML as the fixture) · reader_builder writes a recipe ·
//               the recipe runs on that same page and must pass the checks: it reads jobs, the
//               invariants hold, and it finds the example titles the model read off the page.
//               A recipe that fails gets one more run, which is told what went wrong.
//               The stored page is replayed offline once, and what it gives is the fixture's
//               expected output.
//   commit      the recipe (status ok) with its fixture · the page is read by it from now on ·
//               strategies reading the page run at the next tick. Or: why no recipe could be
//               built, tried again after RECIPE_RETRY_MS.
import { eq } from 'drizzle-orm';
import type { Page } from 'playwright';
import type { ReaderPool } from '../../../browser/reader-pool.ts';
import { type SearchSourceRow, searchSources } from '../../../db/schema.ts';
import type { RunResult } from '../../../models/agent-runner.ts';
import { type RecipeOutput, recipeOutputSchema } from '../../../models/schemas/search.ts';
import type { Handler, HandlerContext, Outcome, Task } from '../../../queue/types.ts';
import {
  capturePage,
  MAX_FIXTURE_HTML,
  openFixture,
  openListing,
  type PageCapture,
} from './page.ts';
import { checkInvariants, type RecipeResult, runRecipe } from './run.ts';
import { type BuiltRecipe, recipeRow, saveRecipe, saveRecipeFailure } from './store.ts';
import {
  describeRecipe,
  type ListingRecipe,
  type LocatorSpec,
  type RecipeListing,
} from './types.ts';

/** reader_builder runs per build: the second one sees what the first recipe got wrong. */
export const BUILD_RUNS = 2;

/** ARIA roles Playwright's getByRole knows (anything else is refused before it runs). */
export const ARIA_ROLES = new Set([
  'alert',
  'alertdialog',
  'application',
  'article',
  'banner',
  'blockquote',
  'button',
  'caption',
  'cell',
  'checkbox',
  'code',
  'columnheader',
  'combobox',
  'complementary',
  'contentinfo',
  'definition',
  'deletion',
  'dialog',
  'directory',
  'document',
  'emphasis',
  'feed',
  'figure',
  'form',
  'generic',
  'grid',
  'gridcell',
  'group',
  'heading',
  'img',
  'insertion',
  'link',
  'list',
  'listbox',
  'listitem',
  'log',
  'main',
  'marquee',
  'math',
  'meter',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'navigation',
  'none',
  'note',
  'option',
  'paragraph',
  'presentation',
  'progressbar',
  'radio',
  'radiogroup',
  'region',
  'row',
  'rowgroup',
  'rowheader',
  'scrollbar',
  'search',
  'searchbox',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'strong',
  'subscript',
  'superscript',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'term',
  'textbox',
  'time',
  'timer',
  'toolbar',
  'tooltip',
  'tree',
  'treegrid',
  'treeitem',
]);

export const BUILDER_SYSTEM = `You write listing recipes for Applyant, a personal job-search tool. A recipe tells a plain Playwright script how to read the list of open jobs on one careers page, every few hours, with no model involved. It covers the list only: each job's title, the link to its own page, and its location and team when the list shows them. The job descriptions are read elsewhere.

You get the page three ways: its ARIA snapshot (roles, accessible names, and each link's /url), a DOM outline (tag#id.classes[role] "own text" → href) and its linked text (the visible text in reading order, each link's address after its text as <https://…>).

Two kinds of recipe:
- locators (almost always): list = the container(s) of the job list (every match is read, so name it precisely: a list or region with its accessible name, or a CSS class used only by the job list; null = the whole page); item = one job inside the list; title, url, location, team = elements inside one item (url null when the title itself is the job's link). Prefer ARIA roles with accessible names ({"role":"link","name":null,"css":null}); a role alone is fine when it's unambiguous inside the item. Use CSS only when no role works ({"role":null,"name":null,"css":".job-card"}), and prefer stable, meaningful class names over generated ones (css-1x2y3z). Names match as case-insensitive substrings, so never put a job's own title in a name.
- textPattern: only for pages with no usable structure. pattern is a JavaScript regex over the linked text, one match per job, with capture groups for the title, the link address (required: the <https://…> after a title) and optionally the location.
- none: when the page has no job list at all (not a careers page, a single job, a login wall, or no open jobs). Say why in note.

Pagination: next = a "next page" control to press (give it as next); scroll = more jobs load as the page scrolls; none otherwise. Don't paginate department tabs or filters.

examples: 3 to 5 job titles exactly as the page shows them, from different parts of the list. The recipe is run on this same page and must find them. jobCount: the number of jobs the page says it has, if it says.

Everything must come from the page as given. Don't guess at elements you can't see.`;

export interface BuildContext {
  /** The recipe that stopped working, and what it read when it was built. */
  previous: {
    recipe: ListingRecipe | null;
    expected: RecipeListing[];
    reason: string | null;
  } | null;
  /** This build's earlier attempt and what was wrong with it. */
  attempt: { recipe: ListingRecipe | null; problems: string[]; got: RecipeListing[] } | null;
}

export function builderPrompt(snap: PageCapture, ctx: BuildContext): string {
  const parts = [
    `Page: ${snap.url}`,
    `Title: ${snap.title || '(none)'}`,
    '',
    'ARIA snapshot:',
    snap.aria,
    '',
    'DOM outline:',
    snap.outline,
    '',
    'Linked text:',
    snap.text,
  ];
  if (ctx.previous?.recipe) {
    parts.push(
      '',
      `This page had a recipe that stopped working${ctx.previous.reason ? ` (${ctx.previous.reason})` : ''}:`,
      ...describeRecipe(ctx.previous.recipe).map((l) => `  ${l}`),
      'When it was built it read these jobs:',
      ...ctx.previous.expected.slice(0, 10).map((l) => `  ${l.title} → ${l.url}`),
    );
  }
  if (ctx.attempt) {
    parts.push(
      '',
      'Your previous recipe for this page did not pass the check:',
      ...(ctx.attempt.recipe ? describeRecipe(ctx.attempt.recipe).map((l) => `  ${l}`) : []),
      'What was wrong:',
      ...ctx.attempt.problems.map((p) => `  - ${p}`),
      ctx.attempt.got.length
        ? `It read ${ctx.attempt.got.length} job(s), the first ones:`
        : 'It read no jobs.',
      ...ctx.attempt.got.slice(0, 15).map((l) => `  ${l.title} → ${l.url}`),
      'Write a recipe that fixes this.',
    );
  }
  return parts.join('\n');
}

function locatorProblem(field: string, l: RecipeOutput['item']): string | null {
  if (!l) return null;
  const role = l.role?.trim() || null;
  const css = l.css?.trim() || null;
  if (role && css) return `${field}: give a role or a CSS selector, not both`;
  if (!role && !css) return `${field}: needs a role or a CSS selector`;
  if (role && !ARIA_ROLES.has(role)) return `${field}: "${role}" is not an ARIA role`;
  if (css && l.name) return `${field}: a CSS selector has no accessible name`;
  return null;
}

/** Checks the zod type can't express; null when the output can be turned into a recipe. */
export function validateRecipeOutput(o: RecipeOutput): string | null {
  if (o.kind === 'none') return null;
  if (o.examples.filter((e) => e.trim()).length === 0) return 'examples: give at least one title';
  if (o.kind === 'locators') {
    if (!o.item) return 'locators: item is required';
    if (!o.title) return 'locators: title is required';
    for (const [field, l] of [
      ['list', o.list],
      ['item', o.item],
      ['title', o.title],
      ['url', o.url],
      ['location', o.location],
      ['team', o.team],
      ['next', o.next],
    ] as const) {
      const p = locatorProblem(field, l);
      if (p) return p;
    }
    if (o.pagination === 'next' && !o.next) return 'pagination next: give the next control';
    return null;
  }
  if (!o.pattern?.trim()) return 'textPattern: pattern is required';
  const flags = o.flags ?? '';
  if (!/^[gimsuy]*$/.test(flags)) return `textPattern: unknown flags "${flags}"`;
  try {
    new RegExp(o.pattern, flags);
  } catch (err) {
    return `textPattern: ${(err as Error).message}`;
  }
  const group = (n: number | null) => n === null || (Number.isInteger(n) && n >= 1 && n <= 20);
  if (o.titleGroup === null || !group(o.titleGroup)) return 'textPattern: titleGroup is required';
  if (o.urlGroup === null || !group(o.urlGroup)) return 'textPattern: urlGroup is required';
  if (!group(o.locationGroup)) return 'textPattern: locationGroup must be a group number';
  return null;
}

function toLocator(l: NonNullable<RecipeOutput['item']>): LocatorSpec {
  const css = l.css?.trim();
  if (css) return { css };
  return { role: (l.role ?? '').trim(), name: l.name?.trim() || null };
}

/** The validated output as a recipe (null for `none`). */
export function toRecipe(o: RecipeOutput): ListingRecipe | null {
  if (o.kind === 'none') return null;
  if (o.kind === 'textPattern') {
    return {
      kind: 'textPattern',
      pattern: o.pattern ?? '',
      flags: (o.flags ?? '').replace(/g/g, ''),
      groups: { title: o.titleGroup ?? 1, url: o.urlGroup, location: o.locationGroup },
    };
  }
  const opt = (l: RecipeOutput['item']) => (l ? toLocator(l) : null);
  return {
    kind: 'locators',
    list: opt(o.list),
    item: toLocator(o.item as NonNullable<RecipeOutput['item']>),
    fields: {
      title: toLocator(o.title as NonNullable<RecipeOutput['item']>),
      url: opt(o.url),
      location: opt(o.location),
      team: opt(o.team),
    },
    pagination:
      o.pagination === 'next' && o.next
        ? { next: toLocator(o.next) }
        : o.pagination === 'scroll'
          ? { scroll: true }
          : null,
  };
}

const norm = (t: string) =>
  t
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** What's wrong with a recipe's first page on the page it was written for; [] = verified. */
export function verificationProblems(
  got: RecipeListing[],
  o: { pageUrl: string; examples: string[]; jobCount: number | null; paginated: boolean },
): string[] {
  if (got.length === 0) return ['it read no jobs from the page'];
  const problems = checkInvariants({ listings: got, pageUrl: o.pageUrl, lastCount: null });
  const titles = got.map((l) => norm(l.title));
  const examples = o.examples.map(norm).filter(Boolean);
  const missing = examples.filter((e) => !titles.some((t) => t.includes(e) || e.includes(t)));
  const need = Math.min(2, examples.length);
  if (examples.length - missing.length < need) {
    problems.push(
      `it didn't find the example titles: ${missing
        .slice(0, 5)
        .map((m) => `"${m}"`)
        .join(', ')}`,
    );
  }
  if (!o.paginated && o.jobCount !== null && o.jobCount >= 4 && got.length < 0.5 * o.jobCount) {
    problems.push(`the page says it has ${o.jobCount} jobs, and the recipe read ${got.length}`);
  }
  return problems;
}

type Attempt = NonNullable<BuildContext['attempt']>;

type BuildResult =
  | { kind: 'built'; built: BuiltRecipe }
  | { kind: 'no_recipe'; reason: string }
  | {
      kind: 'limit';
      provider: Extract<RunResult<unknown>, { kind: 'limit' }>['provider'];
      until: Date;
    };

async function tryRecipe(
  page: Page,
  recipe: ListingRecipe,
  out: RecipeOutput,
  pageUrl: string,
): Promise<{ result: RecipeResult | null; problems: string[] }> {
  try {
    const result = await runRecipe(page, recipe, { paginate: false });
    const problems = verificationProblems(result.firstPage, {
      pageUrl,
      examples: out.examples,
      jobCount: out.jobCount,
      paginated: recipe.kind === 'locators' && recipe.pagination !== null,
    });
    return { result, problems };
  } catch (err) {
    return {
      result: null,
      problems: [`it failed to run: ${(err as Error).message.split('\n')[0]}`],
    };
  }
}

/** The stored page replayed with no network: what the fixture gives (its expected output). */
async function replay(
  page: Page,
  snap: PageCapture,
  recipe: ListingRecipe,
): Promise<RecipeListing[]> {
  const offline = await page.context().newPage();
  try {
    await openFixture(offline, snap.url, snap.html);
    return (await runRecipe(offline, recipe, { paginate: false })).firstPage;
  } finally {
    await offline.close().catch(() => {});
  }
}

async function build(
  task: Task<'build_recipe'>,
  ctx: HandlerContext,
  source: SearchSourceRow,
  reader: ReaderPool,
): Promise<BuildResult> {
  const old = recipeRow(ctx.read, source.id);
  const previous: BuildContext['previous'] = old?.recipe
    ? { recipe: old.recipe, expected: old.expected ?? [], reason: old.note }
    : null;
  return reader.withPage(
    async (page) => {
      ctx.progress({ message: `${source.key}: opening the page` });
      await openListing(page, source.locator);
      const snap = await capturePage(page);
      let attempt: Attempt | null = null;
      for (let run = 1; run <= BUILD_RUNS; run++) {
        const res: RunResult<RecipeOutput> = await ctx.deps.models.run('reader_builder', {
          schema: recipeOutputSchema,
          system: BUILDER_SYSTEM,
          prompt: builderPrompt(snap, { previous, attempt }),
          taskId: task.id,
          signal: ctx.signal,
          progress: (message) => ctx.progress({ message }),
          validate: validateRecipeOutput,
        });
        if (res.kind === 'limit')
          return { kind: 'limit', provider: res.provider, until: res.until };
        if (res.kind === 'failed') {
          attempt = { recipe: null, problems: [res.reason], got: [] };
          continue;
        }
        const recipe = toRecipe(res.output);
        if (!recipe) {
          return {
            kind: 'no_recipe',
            reason: `reader_builder found no job list on the page${res.output.note ? `: ${res.output.note}` : ''}`,
          };
        }
        const tried = await tryRecipe(page, recipe, res.output, snap.url);
        if (tried.problems.length > 0 || !tried.result) {
          ctx.progress({ message: `recipe ${run} failed its check: ${tried.problems.join('; ')}` });
          attempt = { recipe, problems: tried.problems, got: tried.result?.firstPage ?? [] };
          continue;
        }
        const firstPage = tried.result.firstPage;
        let count = firstPage.length;
        let pages = '';
        if (recipe.kind === 'locators' && recipe.pagination) {
          ctx.progress({ message: 'following the pagination' });
          const all = await runRecipe(page, recipe, { paginate: true, signal: ctx.signal }).catch(
            () => null,
          );
          if (all) {
            count = all.listings.length;
            pages = ` over ${'next' in recipe.pagination ? `${all.pages} page(s)` : `${all.scrolls} scroll(s)`}`;
          }
        }
        const keep = snap.html.length <= MAX_FIXTURE_HTML;
        const expected = keep
          ? await replay(page, snap, recipe).catch(() => [] as RecipeListing[])
          : firstPage;
        const replayNote =
          keep && expected.length !== firstPage.length
            ? ` (the stored page replays ${expected.length} of them offline)`
            : keep
              ? ''
              : ' (the page is too large to keep as a fixture)';
        return {
          kind: 'built',
          built: {
            recipe,
            fixtureUrl: snap.url,
            fixtureHtml: keep ? snap.html : null,
            expected,
            count,
            note: `${count} jobs${pages}${run > 1 ? ` (second try)` : ''}${replayNote}`,
          },
        };
      }
      return {
        kind: 'no_recipe',
        reason: `no recipe passed the check after ${BUILD_RUNS} tries: ${(attempt?.problems ?? []).join('; ')}`,
      };
    },
    { signal: ctx.signal },
  );
}

export const buildRecipe: Handler<'build_recipe'> = async (task, ctx): Promise<Outcome> => {
  const source = ctx.read
    .select()
    .from(searchSources)
    .where(eq(searchSources.id, task.entityId))
    .get();
  if (source?.kind !== 'page') return { kind: 'done', commit: () => {} };
  const reader = ctx.deps.reader as ReaderPool | undefined;
  if (typeof reader?.withPage !== 'function') {
    return {
      kind: 'done',
      commit: (tx) => saveRecipeFailure(tx, source, 'the headless reader is not available'),
    };
  }
  let res: BuildResult;
  try {
    res = await build(task, ctx, source, reader);
  } catch (err) {
    ctx.signal.throwIfAborted();
    const reason = `the page couldn't be read: ${(err as Error).message.split('\n')[0]}`;
    return { kind: 'done', commit: (tx) => saveRecipeFailure(tx, source, reason) };
  }
  if (res.kind === 'limit')
    return { kind: 'pause_provider', provider: res.provider, until: res.until };
  if (res.kind === 'no_recipe') {
    const reason = res.reason;
    return { kind: 'done', commit: (tx) => saveRecipeFailure(tx, source, reason) };
  }
  const built = res.built;
  return {
    kind: 'done',
    commit: (tx) => {
      // Deleted or switched to another kind while the build ran: nothing to save.
      const current = tx.db
        .select()
        .from(searchSources)
        .where(eq(searchSources.id, source.id))
        .get();
      if (current?.kind !== 'page') return;
      saveRecipe(tx, current, built);
    },
  };
};
