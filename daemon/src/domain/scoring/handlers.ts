// score_posting: a verified posting → an explained 0–100 score.
//
//   pass 1 (no extraction for this text yet):
//     slow:    posting text (captured at verify, or read now) → extractor
//     commit:  extraction cached on the posting · enqueue score_posting again
//   pass 2:
//     slow:    per requirement hybrid retrieval → cache keys → ONE matcher run for what changed
//              · reference rates when the salary is in another currency
//     commit:  matches · score() over the preferences as of now → stage scored
//
// Two passes, so the extraction is kept even when the matcher then hits a subscription limit
// or fails: nothing already paid for is asked twice. Re-running score_posting with nothing
// changed makes no model call at all.
import { eq } from 'drizzle-orm';
import { type PostingRow, postings } from '../../db/schema.ts';
import { matcherSchema, postingExtractionSchema } from '../../models/schemas/posting.ts';
import type { Handler, HandlerContext, Outcome, Task } from '../../queue/types.ts';
import { fetchPostingText } from '../search/posting-text.ts';
import {
  extractionKey,
  normaliseExtraction,
  POSTING_EXTRACTOR_SYSTEM,
  postingPrompt,
  validatePostingExtraction,
} from './extract.ts';
import { loadRates, needsRates, saveRates } from './fx.ts';
import {
  applyMatcherOutput,
  gatherCandidates,
  MATCHER_SYSTEM,
  matcherPrompt,
  planMatches,
  validateMatcherOutput,
} from './match.ts';
import { getPreferences } from './prefs.ts';
import { rescorePosting, SCORABLE_STAGES } from './store.ts';
import type { StoredMatch } from './types.ts';

/** Failed reads and model runs are retried this many times before the posting gets a note. */
export const SCORE_ATTEMPTS = 3;

export const scorePosting: Handler<'score_posting'> = async (task, ctx) => {
  const posting = ctx.read.select().from(postings).where(eq(postings.id, task.entityId)).get();
  if (!posting || !SCORABLE_STAGES.includes(posting.stage)) {
    return { kind: 'done', commit: () => {} };
  }

  let text = posting.text;
  let jsonLd = posting.jsonLd;
  let fetched = false;
  if (!text) {
    ctx.progress({ message: `reading ${posting.canonicalUrl}` });
    try {
      ({ text, jsonLd } = await fetchPostingText(
        ctx.deps.reader,
        posting.canonicalUrl,
        ctx.signal,
      ));
      fetched = true;
    } catch (err) {
      ctx.signal.throwIfAborted();
      return failOrRetry(task, posting, `can't read the posting: ${(err as Error).message}`, ctx);
    }
    if (!text) return failOrRetry(task, posting, 'the posting page has no readable text', ctx);
  }

  const key = extractionKey(text);
  if (!posting.extraction || posting.extractionKey !== key) {
    return extract(task, ctx, posting, { text, jsonLd }, key, fetched);
  }
  return matchAndScore(task, ctx, posting);
};

async function extract(
  task: Task<'score_posting'>,
  ctx: HandlerContext,
  posting: PostingRow,
  page: { text: string; jsonLd: Record<string, unknown> | null },
  key: string,
  fetched: boolean,
): Promise<Outcome> {
  const { text, jsonLd } = page;
  ctx.progress({ message: 'extracting requirements' });
  const res = await ctx.deps.models.run('extractor', {
    schema: postingExtractionSchema,
    system: POSTING_EXTRACTOR_SYSTEM,
    prompt: postingPrompt({
      url: posting.canonicalUrl,
      title: posting.title,
      company: posting.company,
      text,
    }),
    taskId: task.id,
    signal: ctx.signal,
    progress: (message) => ctx.progress({ message }),
    validate: validatePostingExtraction,
  });
  if (res.kind === 'limit')
    return { kind: 'pause_provider', provider: res.provider, until: res.until };
  if (res.kind === 'failed') return failOrRetry(task, posting, res.reason, ctx);
  // Stored as the model read it; structured page data is applied when scoring
  // (structured.ts), so a change there re-scores without asking the model again.
  const extraction = normaliseExtraction(res.output);
  return {
    kind: 'done',
    commit: (tx) => {
      tx.db
        .update(postings)
        .set({
          ...(fetched ? { text, jsonLd } : {}),
          extraction,
          extractionKey: key,
          title: posting.title ?? extraction.title,
          company: posting.company ?? extraction.company,
          scoreNote: null,
        })
        .where(eq(postings.id, posting.id))
        .run();
      tx.enqueue('score_posting', posting.id);
    },
  };
}

async function matchAndScore(
  task: Task<'score_posting'>,
  ctx: HandlerContext,
  posting: PostingRow,
): Promise<Outcome> {
  const extraction = posting.extraction;
  if (!extraction) return { kind: 'done', commit: () => {} };

  ctx.progress({ message: `retrieving facts for ${extraction.requirements.length} requirements` });
  const candidates = await gatherCandidates(extraction.requirements, ctx.deps, {
    signal: ctx.signal,
    onEmbedError: (err) => ctx.deps.log.warn('query embedding failed', { err: err.message }),
  });
  const plan = planMatches(candidates, posting.matches);
  let answered: StoredMatch[] = [];
  if (plan.ask.length > 0) {
    const asked = plan.ask.map((i) => candidates[i]).filter((c) => c !== undefined);
    ctx.progress({
      message: `matching ${asked.length} requirements (${plan.settled.size} settled without a model call)`,
    });
    const res = await ctx.deps.models.run('matcher', {
      schema: matcherSchema,
      system: MATCHER_SYSTEM,
      prompt: matcherPrompt(asked),
      taskId: task.id,
      signal: ctx.signal,
      progress: (message) => ctx.progress({ message }),
      validate: (out) => validateMatcherOutput(out, asked.length),
    });
    if (res.kind === 'limit') {
      return { kind: 'pause_provider', provider: res.provider, until: res.until };
    }
    if (res.kind === 'failed') return failOrRetry(task, posting, res.reason, ctx);
    answered = applyMatcherOutput(asked, res.output);
  }
  const matches: StoredMatch[] = candidates.map((_, i) => {
    const settled = plan.settled.get(i);
    if (settled) return settled;
    const m = answered[plan.ask.indexOf(i)];
    if (!m) throw new Error(`no match for requirement ${i}`);
    return m;
  });

  // Reference rates, only when the salary has to be converted to be compared.
  const prefs = getPreferences(ctx.read);
  const currencies = [
    extraction.salary?.currency,
    prefs.salary?.currency,
    prefs.salaryFloor?.currency,
  ].filter((c): c is string => !!c);
  let rates: Awaited<ReturnType<typeof ctx.deps.fx.fetch>> | null = null;
  if (needsRates(loadRates(ctx.read), currencies, ctx.now())) {
    try {
      rates = await ctx.deps.fx.fetch(ctx.signal);
    } catch (err) {
      ctx.signal.throwIfAborted();
      ctx.deps.log.warn('exchange rates unavailable', { err: (err as Error).message });
    }
  }

  return {
    kind: 'done',
    commit: (tx) => {
      if (rates) saveRates(tx.db, rates, tx.now);
      const current = tx.db.select().from(postings).where(eq(postings.id, posting.id)).get();
      if (!current) return;
      if (current.extractionKey !== posting.extractionKey) {
        // The posting text changed while matching: these matches are for the old one.
        tx.enqueue('score_posting', posting.id);
        return;
      }
      tx.db
        .update(postings)
        .set({ matches, scoreNote: null })
        .where(eq(postings.id, posting.id))
        .run();
      const result = rescorePosting(tx.db, posting.id, tx.now);
      if (!result) return;
      const stage = current.stage === 'verified' ? 'scored' : current.stage;
      if (stage !== current.stage) {
        tx.db.update(postings).set({ stage }).where(eq(postings.id, posting.id)).run();
      }
      const flags = result.dealbreakers.length
        ? ` · dealbreakers: ${result.dealbreakers.join('; ')}`
        : '';
      tx.emit({
        kind: 'posting.stage',
        postingId: posting.id,
        stage,
        message: `score ${result.score}${flags}`,
      });
    },
  };
}

function failOrRetry(
  task: Task<'score_posting'>,
  posting: PostingRow,
  reason: string,
  ctx: HandlerContext,
): Outcome {
  if (task.attempts + 1 < SCORE_ATTEMPTS) {
    return {
      kind: 'retry',
      after: new Date(ctx.now().getTime() + 60_000 * 2 ** task.attempts),
      reason,
    };
  }
  return {
    kind: 'done',
    commit: (tx) => {
      tx.db
        .update(postings)
        .set({ scoreNote: `scoring failed: ${reason}`.slice(0, 1000) })
        .where(eq(postings.id, posting.id))
        .run();
    },
  };
}
