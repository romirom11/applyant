// What the Sources screen and `applyant search index` show of the ATS index: the index per ATS,
// its companies (filtered, paged) and the switch per company.
import { and, asc, count, desc, eq, type SQL, sql } from 'drizzle-orm';
import type { Conn } from '../../../db/client.ts';
import {
  type AtsCompanyRow,
  type AtsDiscoveryRow,
  atsCompanies,
  searchSources,
} from '../../../db/schema.ts';
import { ATS_KINDS, type Ats } from '../readers/ats-embed.ts';
import { INDEX_SOURCE_KEY } from '../readers/boards.ts';
import { isAts, KIND_LABELS, kindsOff, SearchError } from '../sources.ts';
import { latestDiscoveries } from './discover.ts';

export interface AtsView {
  ats: Ats;
  label: string;
  enabled: boolean;
  companies: number;
  hiring: number;
  jobs: number;
  matching: number;
  lastReadAt: Date | null;
  due: number;
  failing: number;
}

export interface IndexView {
  /** board:ats-index is on (its own switch; not the job boards' kind): strategies search it. */
  enabled: boolean;
  ats: AtsView[];
  discoveries: AtsDiscoveryRow[];
  companies: number;
  jobs: number;
  matching: number;
}

export function indexView(conn: Conn, now: Date): IndexView {
  const off = kindsOff(conn);
  const source = conn
    .select({ enabled: searchSources.enabled })
    .from(searchSources)
    .where(eq(searchSources.key, INDEX_SOURCE_KEY))
    .get();
  const gone = sql`${atsCompanies.status} = 'gone'`;
  const rows = conn
    .select({
      ats: atsCompanies.ats,
      companies: sql<number>`sum(case when ${gone} then 0 else 1 end)`,
      hiring: sql<number>`sum(case when ${atsCompanies.status} = 'hiring' then 1 else 0 end)`,
      jobs: sql<number>`sum(${atsCompanies.jobs})`,
      matching: sql<number>`sum(${atsCompanies.matching})`,
      lastReadAt: sql<number | null>`max(${atsCompanies.lastReadAt})`,
      due: sql<number>`sum(case when ${atsCompanies.enabled} = 1 and ${atsCompanies.nextReadAt} <= ${now.getTime()} then 1 else 0 end)`,
      failing: sql<number>`sum(case when ${atsCompanies.status} = 'failing' then 1 else 0 end)`,
    })
    .from(atsCompanies)
    .groupBy(atsCompanies.ats)
    .all();
  const by = new Map(rows.map((r) => [r.ats, r]));
  const ats = ATS_KINDS.map((k): AtsView => {
    const r = by.get(k);
    return {
      ats: k,
      label: KIND_LABELS[k],
      enabled: !off.has(k),
      companies: r?.companies ?? 0,
      hiring: r?.hiring ?? 0,
      jobs: r?.jobs ?? 0,
      matching: r?.matching ?? 0,
      lastReadAt: r?.lastReadAt ? new Date(r.lastReadAt) : null,
      due: r?.due ?? 0,
      failing: r?.failing ?? 0,
    };
  });
  return {
    enabled: !!source?.enabled,
    ats,
    discoveries: latestDiscoveries(conn, 10),
    companies: ats.reduce((n, a) => n + a.companies, 0),
    jobs: ats.reduce((n, a) => n + a.jobs, 0),
    matching: ats.reduce((n, a) => n + a.matching, 0),
  };
}

export interface CompanyFilter {
  ats?: string | null;
  query?: string;
  matchingOnly?: boolean;
  limit?: number;
  offset?: number;
}

/** Companies the filter selects: matching ones first, then hiring ones, then by name. */
export function listCompanies(
  conn: Conn,
  f: CompanyFilter,
): { companies: AtsCompanyRow[]; total: number } {
  const raw = f.ats?.trim();
  let ats: Ats | null = null;
  if (raw) {
    if (!isAts(raw)) throw new SearchError(`unknown ATS "${raw}" (${ATS_KINDS.join(' | ')})`);
    ats = raw;
  }
  const q = f.query?.trim().toLowerCase();
  const where: SQL[] = [];
  if (ats) where.push(eq(atsCompanies.ats, ats));
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(
      sql`(lower(coalesce(${atsCompanies.name}, '')) like ${like} escape '\\' or lower(${atsCompanies.token}) like ${like} escape '\\')`,
    );
  }
  if (f.matchingOnly) where.push(sql`${atsCompanies.matching} > 0`);
  const cond = where.length ? and(...where) : undefined;
  const limit = Math.min(Math.max(f.limit && f.limit > 0 ? f.limit : 100, 1), 500);
  const offset = Math.max(f.offset ?? 0, 0);
  const companies = conn
    .select()
    .from(atsCompanies)
    .where(cond)
    .orderBy(
      desc(sql`${atsCompanies.matching} > 0`),
      desc(sql`${atsCompanies.status} = 'hiring'`),
      asc(sql`lower(coalesce(${atsCompanies.name}, ${atsCompanies.token}))`),
      asc(atsCompanies.id),
    )
    .limit(limit)
    .offset(offset)
    .all();
  const total = conn.select({ n: count() }).from(atsCompanies).where(cond).get()?.n ?? 0;
  return { companies, total };
}

/** Leaves one company out of the index (not read, not searched), or takes it back. */
export function setCompanyEnabled(conn: Conn, id: number, enabled: boolean): AtsCompanyRow {
  const row = conn
    .update(atsCompanies)
    .set({ enabled })
    .where(eq(atsCompanies.id, id))
    .returning()
    .get();
  if (!row) throw new SearchError(`no company ${id} in the ATS index`);
  return row;
}
