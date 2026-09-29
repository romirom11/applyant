// Company RPCs: research profiles, one per company. validate → domain → proto.
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError, type ServiceImpl } from '@connectrpc/connect';
import { eq } from 'drizzle-orm';
import type { Conn } from '../db/client.ts';
import { type CompanyRow, postings } from '../db/schema.ts';
import {
  CompanyError,
  type CompanyView,
  companyForPosting,
  companyView,
  findCompany,
  listCompanies,
  requestResearch,
} from '../domain/companies/store.ts';
import {
  type ApplyantService,
  type Company,
  CompanySchema,
  type GetCompanyRequest,
} from '../gen/applyant/v1/applyant_pb.js';
import { COMPANY_SECTIONS, type CompanySection } from '../models/schemas/company.ts';
import { runInTx } from '../queue/tx.ts';
import { stageToPb } from './mapping.ts';
import type { RpcContext } from './postings.ts';

type Impl = ServiceImpl<typeof ApplyantService>;

export const SECTION_LABELS: Record<CompanySection, string> = {
  product: 'Product',
  funding: 'Funding',
  size: 'Size',
  founders: 'Founders',
  stack: 'Stack',
  news: 'News',
  layoffs: 'Layoffs',
  reviews: 'Reviews',
  remote: 'Remote culture',
  salary: 'Salary',
};

/** `full` adds every section with its findings (GetCompany). */
export function companyToPb(v: CompanyView, full = false): Company {
  const { row } = v;
  const p = row.profile;
  return create(CompanySchema, {
    id: BigInt(row.id),
    name: row.name,
    status: row.status,
    researching: v.researching,
    fresh: v.fresh,
    trigger: row.trigger,
    website: p?.website ?? undefined,
    summary: p?.summary ?? undefined,
    redFlags: (p?.redFlags ?? []).map((f) => ({ ...f })),
    sections:
      full && p
        ? COMPANY_SECTIONS.filter((k) => p[k].length).map((k) => ({
            key: k,
            label: SECTION_LABELS[k],
            findings: p[k].map((f) => ({
              text: f.text,
              date: f.date ?? undefined,
              sources: f.sources,
            })),
          }))
        : [],
    researchedAt: row.researchedAt ? timestampFromDate(row.researchedAt) : undefined,
    attemptedAt: row.attemptedAt ? timestampFromDate(row.attemptedAt) : undefined,
    note: row.note ?? undefined,
    postings: v.postings.map((x) => ({
      id: BigInt(x.id),
      title: x.title ?? undefined,
      score: x.score ?? undefined,
      stage: stageToPb(x.stage),
    })),
    findings: p ? COMPANY_SECTIONS.reduce((n, k) => n + p[k].length, 0) : 0,
  });
}

/** A company as a posting or application shows it: no sections, no postings. */
export function companyBriefToPb(
  conn: Conn,
  row: CompanyRow | null,
  now: Date,
): Company | undefined {
  if (!row) return undefined;
  const v = companyView(conn, row, now);
  return companyToPb({ ...v, postings: [] });
}

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof CompanyError) throw new ConnectError(err.message, Code.InvalidArgument);
    throw err;
  }
}

function postingCompany(conn: Conn, postingId: bigint): { name: string; row: CompanyRow | null } {
  const posting = conn
    .select({ id: postings.id, company: postings.company })
    .from(postings)
    .where(eq(postings.id, Number(postingId)))
    .get();
  if (!posting) throw new ConnectError(`posting ${postingId} not found`, Code.NotFound);
  if (!posting.company?.trim()) {
    throw new ConnectError(`posting ${postingId} names no company`, Code.FailedPrecondition);
  }
  return { name: posting.company, row: companyForPosting(conn, posting) };
}

function target(
  conn: Conn,
  t: GetCompanyRequest['target'],
): { name: string; row: CompanyRow | null } {
  if (t.case === 'postingId') return postingCompany(conn, t.value);
  if (t.case === 'company' && t.value.trim()) {
    const row = findCompany(conn, t.value);
    return { name: row?.name ?? t.value.trim(), row };
  }
  throw new ConnectError('give a company (id or name) or a posting_id', Code.InvalidArgument);
}

export function companyRpcs(
  c: RpcContext,
): Pick<Impl, 'listCompanies' | 'getCompany' | 'researchCompany'> {
  return {
    listCompanies() {
      return { companies: listCompanies(c.db, c.now()).map((v) => companyToPb(v)) };
    },

    getCompany(req) {
      const { row } = target(c.db, req.target);
      return { company: row ? companyToPb(companyView(c.db, row, c.now()), true) : undefined };
    },

    researchCompany(req) {
      return guard(() => {
        const { name } = target(c.db, req.target);
        const res = runInTx(c.db, c.bus, { now: c.now() }, (tx) =>
          requestResearch(tx, name, { trigger: 'manual', refresh: req.refresh }),
        );
        return {
          company: companyToPb(companyView(c.db, res.company, c.now()), true),
          queued: res.queued,
        };
      });
    },
  };
}
