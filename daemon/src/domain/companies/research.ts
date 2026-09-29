// research_company: researcher (Codex by default, with web search) → one sourced profile per
// company: product, funding, size, founders, stack, news, layoffs, reviews, remote culture and
// salary, each finding with the URLs it came from, and red flags in their own block.
//
//   slow:    one researcher run, seeded with the company's name and the postings that name it
//            (so a common name is the right company)
//   commit:  the profile (researched now) · every posting of the company is scored again
//            (red flags are a soft `company` component) · preparations that waited for the
//            research are started again
//
// A failed run keeps an older profile if there is one; preparation then goes on without it,
// and asks again a day later.
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Conn } from '../../db/client.ts';
import { applications, type CompanyRow, companies, postings, tasks } from '../../db/schema.ts';
import {
  COMPANY_SECTIONS,
  type CompanyResearch,
  companyResearchSchema,
} from '../../models/schemas/company.ts';
import type { Handler, Tx } from '../../queue/types.ts';
import { rescorePosting, scoringContext } from '../scoring/store.ts';
import { companyKey } from './store.ts';

/** Postings shown to the researcher to pin down which company this is. */
const POSTINGS_IN_PROMPT = 5;

export const RESEARCHER_SYSTEM = `You research one company for a job seeker who is deciding whether to apply there and needs material for "Why us?" answers. Use web search. Read the company's own site, its careers page, funding databases and news (Crunchbase, TechCrunch, Sifted, company blog), employee reviews (Glassdoor, Kununu, Blind, Indeed) and layoff trackers (layoffs.fyi, news).

Rules:
- Every finding and every red flag gives the URL(s) of the page(s) that say it: pages you actually opened or saw in results, never a search-results page, never a URL you made up. Nothing without a source.
- Only what the sources say. Say "about 120 employees (LinkedIn, 2026)", not "a mid-sized team". If something isn't findable, leave that list empty and say so in note. Don't pad lists.
- Make sure it's the right company: several companies share names. The job postings below tell you which one is hiring.
- Recent first; give dates for news, funding and layoffs.
- Red flags: only real, sourced concerns for someone joining: layoffs in the last ~18 months, a pattern of poor employee reviews, an outstaffing / body-shop business presented as a product company, pay clearly below the market, money running out, lawsuits or regulatory trouble. Each red flag also appears as a finding in its section. No red flags is a fine and common answer.
- summary: two to four plain sentences on what the company does, for whom, how it makes money, and how big and far along it is. No praise, no marketing words.`;

export interface ResearchPostingRef {
  title: string | null;
  url: string;
  summary: string | null;
}

export function researchPrompt(company: { name: string }, refs: ResearchPostingRef[]): string {
  const lines = [`Company: ${company.name}`, '', 'Its job postings (to tell which company it is):'];
  if (refs.length === 0) lines.push('  (none)');
  for (const r of refs) {
    lines.push(`  - ${r.title ?? '(untitled)'} · ${r.url}${r.summary ? `\n    ${r.summary}` : ''}`);
  }
  lines.push('', 'Research the company and return its profile.');
  return lines.join('\n');
}

const URL_RE = /^https?:\/\/[^\s/]+\.[^\s]+$/i;

/** Each finding and red flag carries at least one real URL. Null = fine. */
export function validateResearch(o: CompanyResearch): string | null {
  if (!o.summary.trim()) return 'summary is empty';
  for (const section of COMPANY_SECTIONS) {
    for (const [i, f] of o[section].entries()) {
      if (!f.sources.some((u) => URL_RE.test(u.trim()))) {
        return `${section}[${i}] ("${f.text.slice(0, 60)}") has no source URL`;
      }
    }
  }
  for (const [i, f] of o.redFlags.entries()) {
    if (!f.sources.some((u) => URL_RE.test(u.trim()))) {
      return `redFlags[${i}] ("${f.text.slice(0, 60)}") has no source URL`;
    }
  }
  return null;
}

/** Sources trimmed, non-URLs dropped, duplicates removed. */
export function normaliseResearch(o: CompanyResearch): CompanyResearch {
  const urls = (list: string[]) => [
    ...new Set(list.map((u) => u.trim()).filter((u) => URL_RE.test(u))),
  ];
  const out: CompanyResearch = {
    ...o,
    name: o.name.trim(),
    website: o.website?.trim() || null,
    summary: o.summary.trim(),
    redFlags: o.redFlags.map((f) => ({ ...f, text: f.text.trim(), sources: urls(f.sources) })),
    note: o.note?.trim() || null,
  };
  for (const section of COMPANY_SECTIONS) {
    out[section] = o[section]
      .map((f) => ({ ...f, text: f.text.trim(), sources: urls(f.sources) }))
      .filter((f) => f.text && f.sources.length);
  }
  return out;
}

export function postingRefs(conn: Conn, company: Pick<CompanyRow, 'key'>): ResearchPostingRef[] {
  return conn
    .select({
      title: postings.title,
      url: postings.canonicalUrl,
      company: postings.company,
      extraction: postings.extraction,
    })
    .from(postings)
    .where(isNotNull(postings.company))
    .orderBy(desc(postings.id))
    .all()
    .filter((p) => companyKey(p.company) === company.key)
    .slice(0, POSTINGS_IN_PROMPT)
    .map((p) => ({ title: p.title, url: p.url, summary: p.extraction?.summary ?? null }));
}

function describe(o: CompanyResearch): string {
  const found = COMPANY_SECTIONS.reduce((n, s) => n + o[s].length, 0);
  const flags = o.redFlags.length
    ? `${o.redFlags.length} red flag${o.redFlags.length === 1 ? '' : 's'} (${o.redFlags
        .map((f) => `${f.kind}, ${f.severity}`)
        .join('; ')})`
    : 'no red flags';
  return `${found} finding${found === 1 ? '' : 's'} · ${flags}`;
}

/** Postings of the company with a score are scored again (red flags changed). */
function rescoreCompany(tx: Tx, key: string): number {
  const ctx = scoringContext(tx.db);
  const rows = tx.db
    .select({ id: postings.id, company: postings.company })
    .from(postings)
    .where(and(isNotNull(postings.extraction), isNotNull(postings.matches)))
    .all()
    .filter((p) => companyKey(p.company) === key);
  let n = 0;
  for (const r of rows) if (rescorePosting(tx.db, r.id, tx.now, ctx)) n++;
  return n;
}

/** Applications of the company still preparing, with nothing queued: they waited for this. */
function resumePreparations(tx: Tx, key: string): number {
  const waiting = tx.db
    .select({ id: applications.id, company: postings.company })
    .from(applications)
    .innerJoin(postings, eq(postings.id, applications.postingId))
    .where(eq(applications.stage, 'preparing'))
    .all()
    .filter((a) => companyKey(a.company) === key);
  let n = 0;
  for (const a of waiting) {
    const busy = tx.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.kind, 'prepare_application'),
          eq(tasks.entityId, a.id),
          inArray(tasks.status, ['queued', 'running']),
        ),
      )
      .get();
    if (busy) continue;
    tx.enqueue('prepare_application', a.id, { runId: null });
    n++;
  }
  return n;
}

export function saveResearch(tx: Tx, company: CompanyRow, output: CompanyResearch): void {
  const profile = normaliseResearch(output);
  const message = describe(profile);
  tx.db
    .update(companies)
    .set({
      status: 'done',
      profile,
      researchedAt: tx.now,
      attemptedAt: tx.now,
      note: profile.note,
      updatedAt: tx.now,
    })
    .where(eq(companies.id, company.id))
    .run();
  rescoreCompany(tx, company.key);
  resumePreparations(tx, company.key);
  tx.emit({
    kind: 'company',
    entityId: company.id,
    runId: null,
    stage: 'done',
    message: `${company.name}: ${message}`,
  });
}

function failResearch(tx: Tx, company: CompanyRow, reason: string): void {
  tx.db
    .update(companies)
    .set({
      status: 'failed',
      attemptedAt: tx.now,
      note: `research failed: ${reason}`.slice(0, 1000),
      updatedAt: tx.now,
    })
    .where(eq(companies.id, company.id))
    .run();
  resumePreparations(tx, company.key);
  tx.emit({
    kind: 'company',
    entityId: company.id,
    runId: null,
    stage: 'failed',
    message: `${company.name}: research failed: ${reason}`.slice(0, 500),
  });
}

export const researchCompany: Handler<'research_company'> = async (task, ctx) => {
  const company = ctx.read.select().from(companies).where(eq(companies.id, task.entityId)).get();
  if (!company) return { kind: 'done', commit: () => {} };
  ctx.progress({ message: `researching ${company.name}` });
  const res = await ctx.deps.models.run('researcher', {
    schema: companyResearchSchema,
    system: RESEARCHER_SYSTEM,
    prompt: researchPrompt(company, postingRefs(ctx.read, company)),
    taskId: task.id,
    signal: ctx.signal,
    progress: (message) => ctx.progress({ message }),
    validate: validateResearch,
    webSearch: true,
  });
  if (res.kind === 'limit')
    return { kind: 'pause_provider', provider: res.provider, until: res.until };
  if (res.kind === 'failed') {
    // Not retried here: preparations waiting on it go on without, and ask again after
    // RETRY_FAILED_MS (the candidate can press Company research any time).
    const reason = res.reason;
    return { kind: 'done', commit: (tx) => failResearch(tx, company, reason) };
  }
  const output = res.output;
  return {
    kind: 'done',
    commit: (tx) => {
      const current = tx.db.select().from(companies).where(eq(companies.id, company.id)).get();
      if (current) saveResearch(tx, current, output);
    },
  };
};
