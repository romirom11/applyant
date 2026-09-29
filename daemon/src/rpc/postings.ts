// Posting and event RPCs: validate → domain → proto.
import { Code, ConnectError, type ServiceImpl } from '@connectrpc/connect';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { type EventRow, postings as postingsTable } from '../db/schema.ts';
import { READABLE_STAGES, requestFormRead } from '../domain/applications/read-form.ts';
import { applicationsByPosting } from '../domain/applications/store.ts';
import { companyForPosting } from '../domain/companies/store.ts';
import { DecisionError, recordDecision, requestScoring } from '../domain/scoring/store.ts';
import { InvalidUrlError } from '../domain/search/canonical-url.ts';
import {
  addPosting,
  citedFacts,
  type EventFilter,
  eventMatches,
  eventsAfter,
  getPosting,
  listEvents,
  listPostings,
} from '../domain/search/postings.ts';
import type { ApplyantService } from '../gen/applyant/v1/applyant_pb.js';
import type { EventBus } from '../queue/events.ts';
import { companyBriefToPb } from './companies.ts';
import { eventToPb, postingToPb, stageFromPb } from './mapping.ts';

export interface RpcContext {
  db: Db;
  bus: EventBus;
  now: () => Date;
}

type Impl = ServiceImpl<typeof ApplyantService>;

function id(value: bigint, what: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new ConnectError(`${what} must be a positive id`, Code.InvalidArgument);
  }
  return n;
}

export function postingRpcs(
  c: RpcContext,
): Pick<
  Impl,
  | 'addPosting'
  | 'listPostings'
  | 'getPosting'
  | 'skipPosting'
  | 'markInterested'
  | 'scorePostings'
  | 'readForms'
  | 'listEvents'
  | 'watchEvents'
> {
  return {
    addPosting(req) {
      try {
        const { posting, created } = addPosting(c.db, c.bus, {
          url: req.url,
          sourceKind: 'manual',
          now: c.now(),
        });
        return { posting: postingToPb(posting), created };
      } catch (err) {
        if (err instanceof InvalidUrlError)
          throw new ConnectError(err.message, Code.InvalidArgument);
        throw err;
      }
    },

    listPostings(req) {
      const rows = listPostings(c.db, stageFromPb(req.stage), req.byScore);
      const apps = applicationsByPosting(c.db);
      return { postings: rows.map((row) => postingToPb(row, [], null, apps.get(row.id) ?? null)) };
    },

    getPosting(req) {
      const found = getPosting(c.db, id(req.id, 'id'));
      if (!found) throw new ConnectError(`posting ${req.id} not found`, Code.NotFound);
      const app = applicationsByPosting(c.db).get(found.posting.id) ?? null;
      const posting = postingToPb(
        found.posting,
        found.sources,
        citedFacts(c.db, found.posting),
        app,
      );
      posting.companyResearch = companyBriefToPb(
        c.db,
        companyForPosting(c.db, found.posting),
        c.now(),
      );
      return { posting };
    },

    skipPosting(req) {
      return decision(() => {
        const res = recordDecision(c.db, c.bus, {
          id: id(req.id, 'id'),
          decision: 'skipped',
          reason: req.reason,
          now: c.now(),
        });
        return { posting: postingToPb(res.posting), rescored: res.rescored };
      });
    },

    markInterested(req) {
      return decision(() => {
        const res = recordDecision(c.db, c.bus, {
          id: id(req.id, 'id'),
          decision: 'interested',
          reason: null,
          now: c.now(),
        });
        const app = applicationsByPosting(c.db).get(res.posting.id) ?? null;
        return { posting: postingToPb(res.posting, [], null, app), rescored: res.rescored };
      });
    },

    scorePostings(req) {
      return decision(() => {
        const ids = req.ids.map((v) => id(v, 'id'));
        const enqueued = requestScoring(c.db, c.bus, ids, c.now(), { refresh: req.refresh });
        return { enqueuedIds: enqueued.map((n) => BigInt(n)) };
      });
    },

    readForms(req) {
      const ids = req.ids.map((v) => id(v, 'id'));
      for (const pid of ids) {
        const row = c.db.select().from(postingsTable).where(eq(postingsTable.id, pid)).get();
        if (!row) throw new ConnectError(`posting ${pid} not found`, Code.NotFound);
        if (!READABLE_STAGES.includes(row.stage)) {
          throw new ConnectError(
            `posting ${pid} is ${row.stage}; only verified or scored postings have a form to read`,
            Code.FailedPrecondition,
          );
        }
      }
      const enqueued = requestFormRead(c.db, c.bus, ids, c.now());
      return { enqueuedIds: enqueued.map((n) => BigInt(n)) };
    },

    listEvents(req) {
      const filter = toFilter(req);
      const limit = req.limit > 0 ? Math.min(req.limit, 1000) : 100;
      return { events: listEvents(c.db, filter, limit).map(eventToPb) };
    },

    async *watchEvents(req, ctx) {
      const filter = toFilter(req);
      const pending: EventRow[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = c.bus.subscribe((event) => {
        if (!eventMatches(event, filter)) return;
        pending.push(event);
        wake?.();
      });
      const onAbort = () => wake?.();
      ctx.signal.addEventListener('abort', onAbort);
      try {
        // Subscribed before reading history, so nothing falls between the two.
        let last = 0;
        if (req.afterEventId !== undefined) {
          last = Number(req.afterEventId);
          for (const event of eventsAfter(c.db, filter, last)) {
            yield { event: eventToPb(event) };
            last = event.id;
          }
        }
        while (!ctx.signal.aborted) {
          const event = pending.shift();
          if (event) {
            if (event.id <= last) continue;
            last = event.id;
            yield { event: eventToPb(event) };
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      } finally {
        unsubscribe();
        ctx.signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

function decision<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof DecisionError) {
      const code = /not found/.test(err.message) ? Code.NotFound : Code.FailedPrecondition;
      throw new ConnectError(err.message, code);
    }
    throw err;
  }
}

function toFilter(req: { runId?: bigint; postingId?: bigint }): EventFilter {
  return {
    runId: req.runId === undefined ? undefined : Number(req.runId),
    postingId: req.postingId === undefined ? undefined : Number(req.postingId),
  };
}
