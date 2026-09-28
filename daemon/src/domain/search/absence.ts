// A posting missing from a source proves nothing unless the source returned everything.
//
//   complete run (a feed, an ATS list API, read to the end):
//     missing   → the link to that source is closed; with no other source still listing the
//                 posting it is closed everywhere, otherwise it is re-verified
//     listed    → a closed link (and a posting closed by absence) opens again
//   partial or failed run (boards, searches, a page of several, a network error):
//     missing   → verify_posting, so posting_liveness decides; never closed. Only postings this
//                 strategy found through this source, at most once per REVERIFY_AFTER_MS.
import { and, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import {
  type PostingStage,
  postingSources,
  postings,
  strategyPostings,
  tasks,
} from '../../db/schema.ts';
import type { Tx } from '../../queue/types.ts';
import type { Listing } from './readers/types.ts';

/** A partial run asks for a re-verification of a posting at most this often. */
export const REVERIFY_AFTER_MS = 3 * 24 * 3_600_000;

/** Stages a live posting can be in (closing applies only to these). */
export const LIVE_STAGES: PostingStage[] = ['found', 'verified', 'scored', 'skipped'];
/** Stages whose postings are worth re-verifying (found ones are being verified already). */
const CHECKED_STAGES: PostingStage[] = ['verified', 'scored', 'skipped'];

export interface AbsenceInput {
  strategyId: number;
  sourceId: number;
  sourceKey: string;
  /** The source's whole list and the read finished. */
  complete: boolean;
  /** Everything the source listed this run (before the strategy's queries); [] when it failed. */
  listed: Listing[];
}

export interface AbsenceResult {
  closed: number;
  reopened: number;
  reverify: number;
}

function verifyBusy(tx: Tx, postingId: number): boolean {
  return !!tx.db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.kind, 'verify_posting'),
        eq(tasks.entityId, postingId),
        inArray(tasks.status, ['queued', 'running']),
      ),
    )
    .get();
}

/** Opens a posting closed by absence again: it is found, and verified from scratch. */
export function reopenPosting(tx: Tx, postingId: number, why: string): boolean {
  const p = tx.db.select().from(postings).where(eq(postings.id, postingId)).get();
  if (p?.stage !== 'closed') return false;
  tx.db
    .update(postings)
    .set({ stage: 'found', verifyNote: why })
    .where(eq(postings.id, p.id))
    .run();
  tx.emit({ kind: 'posting.stage', postingId: p.id, stage: 'found', message: why });
  if (!verifyBusy(tx, p.id)) tx.enqueue('verify_posting', p.id);
  return true;
}

export function applyAbsence(tx: Tx, input: AbsenceInput): AbsenceResult {
  const result: AbsenceResult = { closed: 0, reopened: 0, reverify: 0 };
  const ids = new Set(input.listed.map((l) => l.externalId).filter((x): x is string => !!x));
  const urls = new Set(input.listed.map((l) => l.sourceUrl));
  const listed = (link: { externalId: string | null; url: string }) =>
    (link.externalId !== null && ids.has(link.externalId)) || urls.has(link.url);

  if (input.complete) {
    const links = tx.db
      .select()
      .from(postingSources)
      .where(eq(postingSources.searchSourceId, input.sourceId))
      .all();
    for (const link of links) {
      if (listed(link)) {
        tx.db
          .update(postingSources)
          .set({ lastSeenAt: tx.now, closedAt: null })
          .where(eq(postingSources.id, link.id))
          .run();
        if (
          link.closedAt &&
          reopenPosting(tx, link.postingId, `listed again on ${input.sourceKey}`)
        ) {
          result.reopened++;
        }
        continue;
      }
      if (link.closedAt) continue;
      tx.db
        .update(postingSources)
        .set({ closedAt: tx.now })
        .where(eq(postingSources.id, link.id))
        .run();
      const p = tx.db.select().from(postings).where(eq(postings.id, link.postingId)).get();
      if (!p || !LIVE_STAGES.includes(p.stage)) continue;
      const stillListed = tx.db
        .select({ id: postingSources.id })
        .from(postingSources)
        .where(
          and(
            eq(postingSources.postingId, p.id),
            ne(postingSources.id, link.id),
            isNotNull(postingSources.searchSourceId),
            isNull(postingSources.closedAt),
          ),
        )
        .get();
      if (stillListed) {
        // Another source still lists it: let verification decide.
        if (p.stage !== 'found' && !verifyBusy(tx, p.id)) {
          tx.enqueue('verify_posting', p.id);
          result.reverify++;
        }
        continue;
      }
      const note = `closed: no longer listed on ${input.sourceKey} (its complete list)`;
      tx.db
        .update(postings)
        .set({ stage: 'closed', verifyNote: note })
        .where(eq(postings.id, p.id))
        .run();
      tx.emit({ kind: 'posting.stage', postingId: p.id, stage: 'closed', message: note });
      result.closed++;
    }
    return result;
  }

  // Partial or failed: re-verify what this strategy found here and the source didn't list.
  const links = tx.db
    .select({ link: postingSources, posting: postings })
    .from(postingSources)
    .innerJoin(postings, eq(postings.id, postingSources.postingId))
    .innerJoin(
      strategyPostings,
      and(
        eq(strategyPostings.postingId, postingSources.postingId),
        eq(strategyPostings.strategyId, input.strategyId),
      ),
    )
    .where(eq(postingSources.searchSourceId, input.sourceId))
    .all();
  const due = tx.now.getTime() - REVERIFY_AFTER_MS;
  const asked = new Set<number>();
  for (const { link, posting } of links) {
    if (listed(link)) {
      tx.db
        .update(postingSources)
        .set({ lastSeenAt: tx.now })
        .where(eq(postingSources.id, link.id))
        .run();
      continue;
    }
    if (asked.has(posting.id) || !CHECKED_STAGES.includes(posting.stage)) continue;
    if (posting.verifiedAt && posting.verifiedAt.getTime() > due) continue;
    if (verifyBusy(tx, posting.id)) continue;
    tx.enqueue('verify_posting', posting.id);
    asked.add(posting.id);
    result.reverify++;
  }
  return result;
}
