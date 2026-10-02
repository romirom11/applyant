// search: one run of a strategy.
//
//   slow phase  read each selected source that is switched on (4 at a time): its reader returns
//               the whole list it saw and whether that list is complete · keep the listings the
//               strategy's queries and locations match · group them into postings (dedupe.ts)
//               career pages read by their listing recipe (phase 11) get a sample of their
//               listings checked every few days (listing_check: "a job title with its link?")
//   commit      new postings at `found` (+ verify_posting), every listing as a posting source,
//               the strategy's claim on them · the absence rule per source (absence.ts) · the
//               run's per-source results · a build_recipe for pages that need one (recipes/) ·
//               a `search.run` event
//
// Tasks created here (verify, and from it score and read_form) carry the run's id.
import { and, eq, isNull } from 'drizzle-orm';
import type { ReaderPool } from '../../browser/reader-pool.ts';
import {
  type PostingRow,
  postingSources,
  postings,
  type ResolvedSource,
  type SearchRunSourceResult,
  type SearchSourceRow,
  type SearchStrategyRow,
  searchRuns,
  searchSources,
  searchStrategies,
  strategyPostings,
  type TelegramPostVerdict,
} from '../../db/schema.ts';
import { telegramPostsSchema } from '../../models/schemas/telegram.ts';
import type { Handler, Tx } from '../../queue/types.ts';
import { applyAbsence, reopenPosting } from './absence.ts';
import { type Cluster, DedupeIndex } from './dedupe.ts';
import { readAtsBoard } from './readers/ats-api.ts';
import { isBoardId, readBoard } from './readers/boards.ts';
import { LINKEDIN } from './readers/linkedin.ts';
import { NeedsRecipeError, readPage } from './readers/page.ts';
import { type PlatformAccess, readPlatform } from './readers/platform.ts';
import {
  applyUrlOf,
  type JudgePosts,
  readTelegram,
  TELEGRAM_POSTS_SYSTEM,
  type TelegramReading,
  telegramPostsPrompt,
} from './readers/telegram.ts';
import type { Listing, ReaderContext, ReaderRun } from './readers/types.ts';
import { XING } from './readers/xing.ts';
import {
  type RecipeForRun,
  type RecipeRequest,
  recipesFor,
  recordRecipeRead,
  requestRecipe,
  SAMPLE_EVERY_MS,
} from './recipes/store.ts';
import type { RecipeListing } from './recipes/types.ts';
import { isAts, isPlatformKind, sourcesFor } from './sources.ts';
import { matchesStrategy } from './strategies.ts';

/** New postings one run may add; the rest wait for the next run (they're still new then). */
export const MAX_NEW_PER_RUN = 50;
const PARALLEL_SOURCES = 4;

export interface SourceRead {
  source: SearchSourceRow;
  /** Null when the read failed. */
  run: ReaderRun | null;
  error: string | null;
  /** What a page resolved to, or which Lever host answered (cached on the source). */
  resolved: ResolvedSource | null;
  /** The company the source belongs to, when the API names it. */
  company: string | null;
  /** A career page that needs a (new) listing recipe, and why. */
  needsRecipe: RecipeRequest | null;
  /** Read by its listing recipe: the recipe, how many it read, whether a sample was checked. */
  recipe: { id: number; count: number; sampled: boolean } | null;
}

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split('\n')[0] ?? text;
}

/** Reads one source with the reader its kind needs. Failures become the read's error. */
export async function readSource(
  source: SearchSourceRow,
  ctx: ReaderContext,
  recipe: RecipeForRun | null = null,
): Promise<SourceRead> {
  const read: SourceRead = {
    source,
    run: null,
    error: null,
    resolved: null,
    company: null,
    needsRecipe: null,
    recipe: null,
  };
  try {
    if (isAts(source.kind)) {
      const apiHost = source.resolved?.via === 'lever' ? source.resolved.apiHost : undefined;
      const run = await readAtsBoard(source.kind, source.locator, ctx, { apiHost });
      read.run = run;
      read.company = run.company;
      if (run.apiHost) read.resolved = { via: 'lever', apiHost: run.apiHost };
    } else if (source.kind === 'board') {
      if (!isBoardId(source.locator)) throw new Error(`unknown board "${source.locator}"`);
      read.run = await readBoard(source.locator, ctx);
    } else if (source.kind === 'telegram') {
      const known = source.resolved?.via === 'telegram' ? source.resolved.posts : {};
      const run = await readTelegram(source.locator, ctx, known);
      read.run = run;
      read.resolved = { via: 'telegram', posts: run.posts };
    } else if (isPlatformKind(source.kind)) {
      // LinkedIn/Xing: a stored recipe for the source (when one is ok) over the built-in one.
      const stored = recipe?.status === 'ok' ? recipe.recipe : null;
      read.run = await readPlatform(source.kind === 'linkedin' ? LINKEDIN : XING, ctx, stored);
    } else {
      const run = await readPage(source.locator, ctx, source.resolved ?? null, recipe);
      read.run = run;
      read.resolved = run.resolved;
      read.company = run.company;
      if (run.recipe)
        read.recipe = { id: run.recipe.id, count: run.listings.length, sampled: false };
    }
  } catch (err) {
    ctx.signal.throwIfAborted();
    read.error = message(err);
    if (err instanceof NeedsRecipeError)
      read.needsRecipe = { kind: err.reason, detail: err.message };
  }
  return read;
}

/** Listings a sample check looks at: the first, the middle and the last. */
function sampleOf(listings: RecipeListing[]): RecipeListing[] {
  if (listings.length <= 3) return listings;
  return [listings[0], listings[Math.floor(listings.length / 2)], listings.at(-1)].filter(
    (l): l is RecipeListing => !!l,
  );
}

/**
 * Every few days a sample of a recipe's listings goes to listing_check (Jev by default): is each
 * a job posting's title with its link? Two "no" answers of three mean the recipe reads something
 * else now (a redesign moved the list), and it's rebuilt. An unsure or failed check changes
 * nothing and is tried at the next read.
 */
async function sampleCheck(
  read: SourceRead,
  listings: RecipeListing[],
  ctx: Parameters<typeof searchHandler>[1],
  taskId: number,
): Promise<void> {
  const sample = sampleOf(listings);
  if (sample.length === 0 || !read.recipe) return;
  const res = await ctx.deps.models.decide('listing_check', {
    state: { page: read.source.locator },
    questions: Object.fromEntries(
      sample.map((l, i) => [
        `l${i + 1}`,
        {
          instructions: {
            question: 'Is this a job posting: a job title with the link to its own page?',
            title: l.title,
            link: l.url,
            ...(l.location ? { location: l.location } : {}),
          },
          options: {
            job: 'A job posting: a role title and a link to that job',
            other: 'Something else: navigation, a department or category, a blog post, a filter',
          },
        },
      ]),
    ),
    taskId,
    signal: ctx.signal,
  });
  const answers = Object.values(res.answers).filter((a) => a.sure);
  if (answers.length < sample.length) return;
  const other = answers.filter((a) => a.choice === 'other').length;
  if (other >= 2 || (sample.length === 1 && other === 1)) {
    read.error = `its listing recipe reads something other than jobs now (${other} of ${sample.length} sampled listings)`;
    read.needsRecipe = { kind: 'broken', detail: read.error };
    read.run = null;
    read.recipe = null;
    return;
  }
  read.recipe.sampled = true;
}

function sampleDue(recipe: RecipeForRun, now: Date): boolean {
  return !recipe.lastSampledAt || now.getTime() - recipe.lastSampledAt.getTime() >= SAMPLE_EVERY_MS;
}

function asRecipeListing(l: Listing): RecipeListing {
  return { title: l.title, url: l.url, location: l.location, team: l.team };
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** LinkedIn/Xing reads: the guardrails and a page of Applyant's signed-in browser profile. */
function platformAccess(
  ctx: Parameters<typeof searchHandler>[1],
  taskId: number,
): PlatformAccess | null {
  const guardrails = ctx.deps.guardrails;
  const submit = ctx.deps.submit;
  if (!guardrails || typeof submit?.deliver !== 'function') return null;
  return { guardrails, browse: (fn) => submit.deliver(fn), taskId };
}

/** Telegram reads: the extractor over a channel's new posts, and the candidate's account. */
function telegramReading(
  ctx: Parameters<typeof searchHandler>[1],
  taskId: number,
): TelegramReading {
  const judge: JudgePosts = async (channel, posts) => {
    const res = await ctx.deps.models.run('extractor', {
      schema: telegramPostsSchema,
      system: TELEGRAM_POSTS_SYSTEM,
      prompt: telegramPostsPrompt(channel, posts),
      taskId,
      signal: ctx.signal,
      progress: (message) => ctx.progress({ message }),
    });
    // The channel's posts are judged at a later run; the others' reads go on.
    if (res.kind === 'limit') {
      throw new Error(
        `the extractor is at its ${res.provider} limit until ${res.until.toISOString()}`,
      );
    }
    if (res.kind === 'failed')
      throw new Error(`the extractor failed on @${channel}: ${res.reason}`);
    const ids = new Set(posts.map((p) => p.id));
    const out = new Map<string, TelegramPostVerdict | null>();
    for (const p of res.output.posts) {
      if (!ids.has(p.post)) continue;
      const role = p.role?.trim();
      out.set(
        p.post,
        p.job && role
          ? {
              role,
              company: p.company?.trim() || null,
              salary: p.salary?.trim() || null,
              location: p.location?.trim() || null,
              remote: p.remote,
              contact: p.contact?.trim() || null,
              applyUrl: applyUrlOf(p),
            }
          : null,
      );
    }
    return out;
  };
  return { judge, account: ctx.deps.telegram ?? null };
}

export const searchHandler: Handler<'search'> = async (task, ctx) => {
  const strategy = ctx.read
    .select()
    .from(searchStrategies)
    .where(eq(searchStrategies.id, task.entityId))
    .get();
  // Deleted since the run was queued: its run row went with it.
  if (!strategy) return { kind: 'done', commit: () => {} };

  const run =
    task.runId !== null
      ? ctx.read
          .select({ sourceIds: searchRuns.sourceIds })
          .from(searchRuns)
          .where(eq(searchRuns.id, task.runId))
          .get()
      : undefined;
  // A run for one source (a page that just got its recipe) reads only that source.
  const only = run?.sourceIds ? new Set(run.sourceIds) : null;
  const sources = sourcesFor(ctx.read, strategy.sources).filter((s) => !only || only.has(s.id));
  const recipes = recipesFor(
    ctx.read,
    sources.filter((s) => s.kind === 'page' || isPlatformKind(s.kind)).map((s) => s.id),
  );
  ctx.progress({ message: `${strategy.name}: reading ${sources.length} source(s)` });
  const reader = ctx.deps.reader as ReaderPool | undefined;
  const rctx: ReaderContext = {
    fetch: ctx.deps.fetch ?? globalThis.fetch,
    signal: ctx.signal,
    queries: strategy.queries,
    reader: typeof reader?.withPage === 'function' ? reader : null,
    now: ctx.now(),
    locations: strategy.locations,
    platform: platformAccess(ctx, task.id),
    telegram: telegramReading(ctx, task.id),
  };
  const reads = await mapLimit(sources, PARALLEL_SOURCES, async (s) => {
    const recipe = recipes.get(s.id) ?? null;
    const r = await readSource(s, rctx, recipe);
    if (r.recipe && r.run && recipe && sampleDue(recipe, rctx.now)) {
      await sampleCheck(r, r.run.listings.map(asRecipeListing), ctx, task.id);
    }
    ctx.progress({
      message: `${s.key}: ${r.error ? `failed: ${r.error}` : (r.run?.note ?? `${r.run?.listings.length ?? 0} jobs`)}`,
    });
    return r;
  });

  const candidates = reads.flatMap((r) =>
    (r.run?.listings ?? [])
      .filter((l) => matchesStrategy(l, strategy))
      .map((listing) => ({
        // Lever's and Ashby's list APIs don't name the company: the board is one company's, so
        // its name is the source's. Without it the board's per-city copies of one role can't be
        // told to be the same posting.
        listing:
          listing.company || !isAts(r.source.kind) || !r.source.label
            ? listing
            : { ...listing, company: r.source.label },
        sourceId: r.source.id,
        companyBoard: isAts(r.source.kind) || r.source.kind === 'page',
      })),
  );
  const index = DedupeIndex.load(ctx.read);
  const clusters = await index.plan(candidates, {
    embedder: ctx.deps.embedder,
    signal: ctx.signal,
    textOf: (id) => {
      const p = ctx.read
        .select({ listingText: postings.listingText, text: postings.text })
        .from(postings)
        .where(eq(postings.id, id))
        .get();
      return p?.listingText ?? p?.text ?? null;
    },
  });

  return {
    kind: 'done',
    commit: (tx) => commitSearch(tx, { strategy, runId: task.runId, reads, clusters }),
  };
};

interface CommitInput {
  strategy: SearchStrategyRow;
  runId: number | null;
  reads: SourceRead[];
  clusters: Cluster[];
}

function emptyResult(r: SourceRead): SearchRunSourceResult {
  return {
    sourceKey: r.source.key,
    label: r.source.label,
    listed: r.run?.listings.length ?? 0,
    matched: 0,
    added: 0,
    attached: 0,
    complete: r.run?.complete ?? false,
    closed: 0,
    reopened: 0,
    reverify: 0,
    error: r.error,
    note: r.run?.note ?? null,
  };
}

function findPosting(tx: Tx, url: string, atsKey: string | null): PostingRow | null {
  return (
    tx.db.select().from(postings).where(eq(postings.canonicalUrl, url)).get() ??
    (atsKey ? tx.db.select().from(postings).where(eq(postings.atsKey, atsKey)).get() : null) ??
    null
  );
}

function linkListing(tx: Tx, postingId: number, source: SearchSourceRow, l: Listing): void {
  tx.db
    .insert(postingSources)
    .values({
      postingId,
      kind: source.kind,
      url: l.sourceUrl,
      firstSeenAt: tx.now,
      searchSourceId: source.id,
      externalId: l.externalId,
      lastSeenAt: tx.now,
      closedAt: null,
    })
    .onConflictDoUpdate({
      target: [postingSources.postingId, postingSources.kind, postingSources.url],
      set: {
        searchSourceId: source.id,
        externalId: l.externalId,
        lastSeenAt: tx.now,
        closedAt: null,
      },
    })
    .run();
}

export function commitSearch(tx: Tx, input: CommitInput): void {
  const { strategy, runId } = input;
  const bySource = new Map(input.reads.map((r) => [r.source.id, r]));
  const results = new Map(input.reads.map((r) => [r.source.id, emptyResult(r)]));

  // An empty "complete" list from a source that lists postings is more likely a broken board
  // (renamed, moved) than every job closing at once: it doesn't close anything.
  for (const r of input.reads) {
    if (!r.run?.complete || r.run.listings.length > 0) continue;
    const open = tx.db
      .select({ id: postingSources.id })
      .from(postingSources)
      .where(and(eq(postingSources.searchSourceId, r.source.id), isNull(postingSources.closedAt)))
      .get();
    if (open) {
      r.run = {
        ...r.run,
        complete: false,
        note: `${r.run.note ?? ''} (an empty list; not trusted to close postings)`.trim(),
      };
      const res = results.get(r.source.id);
      if (res) {
        res.complete = false;
        res.note = r.run.note;
      }
    }
  }

  let added = 0;
  let left = 0;
  for (const cluster of input.clusters) {
    const [first] = cluster.candidates;
    if (!first) continue;
    for (const c of cluster.candidates) {
      const res = results.get(c.sourceId);
      if (res) res.matched++;
    }
    // The plan was made on a snapshot: check the exact keys again under the lock.
    let posting =
      (cluster.postingId !== null
        ? tx.db.select().from(postings).where(eq(postings.id, cluster.postingId)).get()
        : null) ?? findPosting(tx, cluster.canonicalUrl, cluster.atsKey);
    let created = false;
    if (!posting) {
      if (added >= MAX_NEW_PER_RUN) {
        left++;
        continue;
      }
      const l = first.listing;
      posting = tx.db
        .insert(postings)
        .values({
          stage: 'found',
          canonicalUrl: cluster.canonicalUrl,
          title: l.title,
          company: l.company ?? bySource.get(first.sourceId)?.company ?? null,
          firstSeenAt: tx.now,
          atsKey: cluster.atsKey,
          minhash: cluster.minhash,
          listingText: l.description,
          locations: cluster.locations.length ? cluster.locations : null,
          // A Telegram post names where to apply (a contact, an address, a job page): verify
          // starts from it (the post itself has no form).
          ...(bySource.get(first.sourceId)?.source.kind === 'telegram' && l.applyUrl
            ? { applyUrl: l.applyUrl }
            : {}),
          ...(cluster.roleTitle ? { title: cluster.roleTitle } : {}),
        })
        .returning()
        .get();
      tx.emit({
        kind: 'posting.stage',
        postingId: posting.id,
        stage: 'found',
        message: `${posting.canonicalUrl} (via ${bySource.get(first.sourceId)?.source.key ?? 'search'})`,
      });
      tx.enqueue('verify_posting', posting.id);
      created = true;
      added++;
    } else {
      // What the listing knows and the posting doesn't yet.
      const fill: Partial<PostingRow> = {};
      if (!posting.atsKey && cluster.atsKey) fill.atsKey = cluster.atsKey;
      if (!posting.minhash && cluster.minhash) fill.minhash = cluster.minhash;
      if (!posting.listingText && first.listing.description)
        fill.listingText = first.listing.description;
      if (!posting.title) fill.title = first.listing.title;
      if (!posting.company && first.listing.company) fill.company = first.listing.company;
      const known = posting.locations ?? [];
      const more = cluster.locations.filter((l) => !known.includes(l));
      if (more.length) fill.locations = [...known, ...more];
      if (cluster.roleTitle && posting.title !== cluster.roleTitle) fill.title = cluster.roleTitle;
      if (Object.keys(fill).length) {
        tx.db.update(postings).set(fill).where(eq(postings.id, posting.id)).run();
      }
      const src = bySource.get(first.sourceId)?.source.key ?? 'search';
      if (reopenPosting(tx, posting.id, `listed again on ${src}`)) {
        const res = results.get(first.sourceId);
        if (res) res.reopened++;
      }
    }
    cluster.candidates.forEach((c, i) => {
      const read = bySource.get(c.sourceId);
      if (!read || !posting) return;
      linkListing(tx, posting.id, read.source, c.listing);
      const res = results.get(c.sourceId);
      if (res) {
        if (created && i === 0) res.added++;
        else res.attached++;
      }
    });
    tx.db
      .insert(strategyPostings)
      .values({ strategyId: strategy.id, postingId: posting.id, runId, firstSeenAt: tx.now })
      .onConflictDoNothing()
      .run();
  }

  // Absence, per source, over everything it listed (not only what this strategy matched).
  for (const r of input.reads) {
    const a = applyAbsence(tx, {
      strategyId: strategy.id,
      sourceId: r.source.id,
      sourceKey: r.source.key,
      complete: !!r.run?.complete,
      listed: r.run?.listings ?? [],
    });
    const res = results.get(r.source.id);
    if (res) {
      res.closed += a.closed;
      res.reopened += a.reopened;
      res.reverify += a.reverify;
    }
  }

  // Career pages: a build for those that need a recipe; the count and sample time of the rest.
  for (const r of input.reads) {
    if (r.needsRecipe) requestRecipe(tx, r.source, r.needsRecipe);
    if (r.recipe)
      recordRecipeRead(tx, r.recipe.id, { count: r.recipe.count, sampled: r.recipe.sampled });
  }

  // The sources' own state: last read, and what a page resolved to. A company board the
  // planner found whose ATS says it doesn't exist (a stale search result) is switched off,
  // with the reason, instead of failing every run; the candidate's own boards stay on.
  for (const r of input.reads) {
    const label =
      r.company && r.source.label === r.source.locator && r.source.kind !== 'page'
        ? r.company
        : r.source.label;
    const gone =
      r.source.origin === 'agent' && isAts(r.source.kind) && /^HTTP (404|410) /.test(r.error ?? '');
    tx.db
      .update(searchSources)
      .set({
        lastRunAt: tx.now,
        lastCount: r.run ? r.run.listings.length : null,
        lastComplete: r.run ? r.run.complete : null,
        lastNote: gone
          ? `switched off: the board isn't there (${r.error})`
          : r.needsRecipe
            ? r.error
            : r.error
              ? `failed: ${r.error}`
              : (r.run?.note ?? null),
        ...(gone ? { enabled: false } : {}),
        label,
        ...(r.resolved ? { resolved: r.resolved } : {}),
      })
      .where(eq(searchSources.id, r.source.id))
      .run();
  }

  const all = [...results.values()];
  const listed = all.reduce((n, r) => n + r.listed, 0);
  const failed = all.filter((r) => r.error).length;
  const closed = all.reduce((n, r) => n + r.closed, 0);
  const parts = [
    `${listed} listed`,
    `${all.reduce((n, r) => n + r.matched, 0)} matched`,
    `${added} new`,
    ...(closed ? [`${closed} closed`] : []),
    ...(failed ? [`${failed} source(s) failed`] : []),
    ...(left ? [`${left} more new left for the next run`] : []),
  ];
  const note =
    input.reads.length === 0
      ? 'no sources to read: every selected source is off'
      : parts.join(' · ');
  if (runId !== null) {
    tx.db
      .update(searchRuns)
      .set({
        status: input.reads.length > 0 && failed === input.reads.length ? 'failed' : 'done',
        finishedAt: tx.now,
        listed,
        added,
        results: all,
        note,
      })
      .where(eq(searchRuns.id, runId))
      .run();
  }
  tx.db
    .update(searchStrategies)
    .set({ lastRunAt: tx.now })
    .where(eq(searchStrategies.id, strategy.id))
    .run();
  tx.emit({
    kind: 'search.run',
    runId,
    entityId: strategy.id,
    stage: input.reads.length > 0 && failed === input.reads.length ? 'failed' : 'done',
    message: `${strategy.name}: ${note}`,
  });
}
