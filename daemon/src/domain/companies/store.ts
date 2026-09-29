// Companies: one research profile per company, shared by all of its postings. Postings name
// their company as text, so they're matched by a normalised key ("Acme AI, Inc." → "acme ai").
// Research runs once per company for roles worth pursuing (preparing an application) or when
// the candidate asks, and again when the profile is older than FRESH_MS.
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Conn } from '../../db/client.ts';
import { type CompanyRow, companies, postings, providerPauses, tasks } from '../../db/schema.ts';
import type { RedFlag } from '../../models/schemas/company.ts';
import type { Tx } from '../../queue/types.ts';

/** A profile younger than this is used as is; an older one is researched again. */
export const FRESH_MS = 30 * 24 * 3_600_000;
/** After a failed research, preparation doesn't ask again for this long. */
export const RETRY_FAILED_MS = 24 * 3_600_000;

export class CompanyError extends Error {}

const LEGAL =
  /\b(inc|incorporated|ltd|limited|llc|l\.l\.c|gmbh|ag|sa|sas|sarl|bv|b\.v|nv|plc|corp|corporation|oy|ab|aps|srl|spa|s\.a|pte|pty|kg|ug|ike)\b\.?/g;

/** "Acme AI, Inc." → "acme ai"; "ACME-AI GmbH" → "acme ai". Empty for no usable name. */
export function companyKey(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}.]+/gu, ' ')
    .replace(LEGAL, ' ')
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function companyByKey(conn: Conn, key: string): CompanyRow | null {
  if (!key) return null;
  return conn.select().from(companies).where(eq(companies.key, key)).get() ?? null;
}

export function companyForPosting(
  conn: Conn,
  posting: { company: string | null },
): CompanyRow | null {
  return companyByKey(conn, companyKey(posting.company));
}

export function isFresh(row: Pick<CompanyRow, 'researchedAt' | 'profile'>, now: Date): boolean {
  return (
    !!row.profile && !!row.researchedAt && now.getTime() - row.researchedAt.getTime() < FRESH_MS
  );
}

export function researchInFlight(conn: Conn, companyId: number): boolean {
  return !!conn
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.kind, 'research_company'),
        eq(tasks.entityId, companyId),
        inArray(tasks.status, ['queued', 'running']),
      ),
    )
    .get();
}

/** Whether queued research can't run now because its provider waits for a limit to reset. */
export function researchPaused(conn: Conn, companyId: number, now: Date): boolean {
  const task = conn
    .select({ provider: tasks.provider })
    .from(tasks)
    .where(
      and(
        eq(tasks.kind, 'research_company'),
        eq(tasks.entityId, companyId),
        eq(tasks.status, 'queued'),
      ),
    )
    .get();
  if (!task?.provider) return false;
  const pause = conn
    .select()
    .from(providerPauses)
    .where(eq(providerPauses.provider, task.provider))
    .get();
  return !!pause && pause.until.getTime() > now.getTime();
}

export interface ResearchRequest {
  company: CompanyRow;
  /** False when research was already waiting or running. */
  queued: boolean;
}

/**
 * Starts research for a company (created on first use). A fresh profile is kept unless
 * `refresh`; research already waiting or running isn't started twice.
 */
export function requestResearch(
  tx: Tx,
  name: string,
  o: { trigger: 'prepare' | 'manual'; refresh?: boolean },
): ResearchRequest {
  const key = companyKey(name);
  if (!key) throw new CompanyError(`"${name}" is not a company name`);
  let row = companyByKey(tx.db, key);
  if (!row) {
    row = tx.db
      .insert(companies)
      .values({ key, name: name.trim(), status: 'queued', trigger: o.trigger, createdAt: tx.now })
      .returning()
      .get();
  } else if (researchInFlight(tx.db, row.id) || (isFresh(row, tx.now) && !o.refresh)) {
    return { company: row, queued: false };
  }
  row = tx.db
    .update(companies)
    .set({ status: 'queued', trigger: o.trigger, updatedAt: tx.now })
    .where(eq(companies.id, row.id))
    .returning()
    .get();
  tx.enqueue('research_company', row.id, { runId: null });
  tx.emit({
    kind: 'company',
    entityId: row.id,
    runId: null,
    stage: 'queued',
    message: `researching ${row.name}${o.trigger === 'prepare' ? ' (preparing an application)' : ''}`,
  });
  return { company: row, queued: true };
}

// ---- views --------------------------------------------------------------------------------

export interface CompanyView {
  row: CompanyRow;
  /** Postings naming this company (by key), newest first. */
  postings: Array<{ id: number; title: string | null; score: number | null; stage: string }>;
  researching: boolean;
  fresh: boolean;
}

function postingsByKey(conn: Conn): Map<string, CompanyView['postings']> {
  const rows = conn
    .select({
      id: postings.id,
      title: postings.title,
      company: postings.company,
      score: postings.score,
      stage: postings.stage,
    })
    .from(postings)
    .where(isNotNull(postings.company))
    .orderBy(desc(postings.id))
    .all();
  const map = new Map<string, CompanyView['postings']>();
  for (const r of rows) {
    const key = companyKey(r.company);
    if (!key) continue;
    const list = map.get(key) ?? [];
    list.push({ id: r.id, title: r.title, score: r.score, stage: r.stage });
    map.set(key, list);
  }
  return map;
}

export function listCompanies(conn: Conn, now: Date): CompanyView[] {
  const byKey = postingsByKey(conn);
  return conn
    .select()
    .from(companies)
    .orderBy(desc(companies.updatedAt))
    .all()
    .map((row) => ({
      row,
      postings: byKey.get(row.key) ?? [],
      researching: researchInFlight(conn, row.id),
      fresh: isFresh(row, now),
    }));
}

export function companyView(conn: Conn, row: CompanyRow, now: Date): CompanyView {
  return {
    row,
    postings: postingsByKey(conn).get(row.key) ?? [],
    researching: researchInFlight(conn, row.id),
    fresh: isFresh(row, now),
  };
}

/** A company by id, key or name. */
export function findCompany(conn: Conn, ref: string): CompanyRow | null {
  const t = ref.trim();
  if (/^\d+$/.test(t)) {
    const byId = conn
      .select()
      .from(companies)
      .where(eq(companies.id, Number(t)))
      .get();
    if (byId) return byId;
  }
  return companyByKey(conn, companyKey(t));
}

// ---- what scoring and the writer take from a profile ----------------------------------------

export interface CompanyScoreInfo {
  name: string;
  redFlags: Array<Pick<RedFlag, 'kind' | 'severity' | 'text'>>;
}

/** Every researched company's red flags, by key (for score()). */
export function companyScoreInfo(conn: Conn): Map<string, CompanyScoreInfo> {
  const rows = conn.select().from(companies).where(isNotNull(companies.profile)).all();
  return new Map(
    rows.map((r) => [
      r.key,
      {
        name: r.name,
        redFlags: (r.profile?.redFlags ?? []).map((f) => ({
          kind: f.kind,
          severity: f.severity,
          text: f.text,
        })),
      },
    ]),
  );
}
