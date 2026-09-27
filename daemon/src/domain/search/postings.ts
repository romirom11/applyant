// Postings as the rest of the daemon sees them. Every entry point (jobs add, the Share
// extension, search) joins here at stage `found`, followed by a verify_posting task.
import { and, asc, desc, eq, gt, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import {
  type EventRow,
  events,
  type PostingRow,
  type PostingSourceRow,
  type PostingStage,
  postingSources,
  postings,
} from '../../db/schema.ts';
import type { EventBus } from '../../queue/events.ts';
import { runInTx } from '../../queue/tx.ts';
import { canonicalUrl } from './canonical-url.ts';

export interface AddPostingResult {
  posting: PostingRow;
  created: boolean;
}

export function addPosting(
  db: Db,
  bus: EventBus,
  input: { url: string; sourceKind: string; now: Date },
): AddPostingResult {
  const canonical = canonicalUrl(input.url);
  const sourceUrl = input.url.trim();
  return runInTx(db, bus, { now: input.now }, (tx) => {
    const existing = tx.db
      .select()
      .from(postings)
      .where(eq(postings.canonicalUrl, canonical))
      .get();
    const posting =
      existing ??
      tx.db
        .insert(postings)
        .values({ stage: 'found', canonicalUrl: canonical, firstSeenAt: tx.now })
        .returning()
        .get();
    tx.db
      .insert(postingSources)
      .values({
        postingId: posting.id,
        kind: input.sourceKind,
        url: sourceUrl,
        firstSeenAt: tx.now,
      })
      .onConflictDoNothing()
      .run();
    if (existing) return { posting: existing, created: false };
    tx.emit({ kind: 'posting.stage', postingId: posting.id, stage: 'found', message: canonical });
    tx.enqueue('verify_posting', posting.id);
    return { posting, created: true };
  });
}

export function listPostings(db: Db, stage?: PostingStage): PostingRow[] {
  const q = db.select().from(postings);
  return (stage ? q.where(eq(postings.stage, stage)) : q).orderBy(desc(postings.id)).all();
}

export function getPosting(
  db: Db,
  id: number,
): { posting: PostingRow; sources: PostingSourceRow[] } | null {
  const posting = db.select().from(postings).where(eq(postings.id, id)).get();
  if (!posting) return null;
  const sources = db
    .select()
    .from(postingSources)
    .where(eq(postingSources.postingId, id))
    .orderBy(asc(postingSources.id))
    .all();
  return { posting, sources };
}

export interface EventFilter {
  runId?: number | undefined;
  postingId?: number | undefined;
}

export function eventMatches(event: EventRow, f: EventFilter): boolean {
  if (f.runId !== undefined && event.runId !== f.runId) return false;
  if (f.postingId !== undefined && event.postingId !== f.postingId) return false;
  return true;
}

function eventWhere(f: EventFilter, afterId?: number): SQL | undefined {
  const parts: SQL[] = [];
  if (f.runId !== undefined) parts.push(eq(events.runId, f.runId));
  if (f.postingId !== undefined) parts.push(eq(events.postingId, f.postingId));
  if (afterId !== undefined) parts.push(gt(events.id, afterId));
  return parts.length ? and(...parts) : undefined;
}

/** The newest `limit` matching events, oldest first. */
export function listEvents(db: Db, f: EventFilter, limit: number): EventRow[] {
  return db
    .select()
    .from(events)
    .where(eventWhere(f))
    .orderBy(desc(events.id))
    .limit(limit)
    .all()
    .reverse();
}

/** Stored events after `afterId`, oldest first (WatchEvents replay). */
export function eventsAfter(db: Db, f: EventFilter, afterId: number, limit = 1000): EventRow[] {
  return db
    .select()
    .from(events)
    .where(eventWhere(f, afterId))
    .orderBy(asc(events.id))
    .limit(limit)
    .all();
}
