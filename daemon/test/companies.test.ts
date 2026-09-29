// Company research (a scripted codex as researcher, through the real queue): preparing an
// application researches its company once; the answers wait for it and are written with the
// company's summary; red flags re-score the company's postings; a profile is reused for 30
// days, then refreshed without holding preparation up; a failed research never blocks it.
import { create } from '@bufbuild/protobuf';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { companies, postings, tasks } from '../src/db/schema.ts';
import { ensureApplication } from '../src/domain/applications/store.ts';
import {
  cleanSourceUrl,
  normaliseResearch,
  validateResearch,
} from '../src/domain/companies/research.ts';
import {
  companyKey,
  FRESH_MS,
  findCompany,
  listCompanies,
  requestResearch,
} from '../src/domain/companies/store.ts';
import {
  type Company,
  GetCompanyRequestSchema,
  ListCompaniesRequestSchema,
  type ListCompaniesResponse,
  ResearchCompanyRequestSchema,
} from '../src/gen/applyant/v1/applyant_pb.js';
import type { ProviderRequest, ProviderResult } from '../src/models/agent-runner.ts';
import { FakeProvider } from '../src/models/providers/fake.ts';
import type { CompanyResearch } from '../src/models/schemas/company.ts';
import type { PostingExtraction } from '../src/models/schemas/posting.ts';
import { runInTx } from '../src/queue/tx.ts';
import { companyRpcs } from '../src/rpc/companies.ts';
import {
  form,
  type PrepareHarness,
  prepareHarness,
  SYNTHETIC_PROFILE,
  seedPosting,
  setProfile,
  spec,
} from './helpers/applications.ts';
import { type TempDb, tempDb } from './helpers/db.ts';

const RESEARCH: CompanyResearch = {
  name: 'Acme AI',
  website: 'https://acme.example.test',
  summary: 'Acme AI sells call analytics to clinics. About 80 people, Series A in 2025.',
  product: [
    {
      text: 'Call analytics for dental and veterinary clinics, sold per seat.',
      date: null,
      sources: ['https://acme.example.test/product'],
    },
  ],
  funding: [
    {
      text: 'Raised a €12M Series A led by Northwind in March 2025.',
      date: '2025-03',
      sources: ['https://news.example.test/acme-series-a', 'not a url'],
    },
  ],
  size: [],
  founders: [],
  stack: [
    { text: 'Python and TypeScript.', date: null, sources: ['https://acme.example.test/jobs'] },
  ],
  news: [
    {
      text: 'Launched a German-language model in July 2026.',
      date: '2026-07',
      sources: ['https://acme.example.test/blog/de'],
    },
  ],
  layoffs: [
    {
      text: 'Laid off 15% of staff in January 2026.',
      date: '2026-01',
      sources: ['https://layoffs.example.test/acme'],
    },
  ],
  reviews: [],
  remote: [],
  salary: [],
  redFlags: [
    {
      kind: 'layoffs',
      severity: 'high',
      text: 'Laid off 15% of staff in January 2026.',
      sources: ['https://layoffs.example.test/acme'],
    },
  ],
  note: 'No employee reviews found.',
};

const EXTRACTION: PostingExtraction = {
  title: 'Senior AI Engineer',
  company: 'Acme AI',
  summary: 'Build LLM systems for call analytics.',
  seniority: 'senior',
  roleFamilies: ['ai_ml'],
  requirements: [],
  workplace: 'remote',
  remoteRegions: ['europe'],
  remoteCountries: [],
  offices: [],
  salary: null,
  languages: [],
  postingLanguage: 'en',
  employment: 'full_time',
  outstaffing: false,
};

const WHY = 'Why do you want to work at Acme AI?';

describe('company research', () => {
  let t: TempDb;
  let h: PrepareHarness | null = null;
  let codex: FakeProvider;
  let researched: ProviderRequest[];
  let reply: (req: ProviderRequest) => ProviderResult;
  let clock: number;
  const now = () => new Date(clock);

  beforeEach(() => {
    t = tempDb();
    clock = Date.now();
    researched = [];
    reply = (req) => ({
      kind: 'ok',
      output: RESEARCH,
      model: req.model,
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
    });
    codex = new FakeProvider('codex', [], (req) => {
      researched.push(req);
      return reply(req);
    });
    setProfile(t.db, SYNTHETIC_PROFILE, now());
  });
  afterEach(async () => {
    await h?.stop();
    h = null;
    t.cleanup();
  });

  const start = async () => {
    h = await prepareHarness(t, {}, { codex });
    return h;
  };
  const tx = <T>(fn: Parameters<typeof runInTx<T>>[3]) =>
    runInTx(t.db, (h as PrepareHarness).bus, { now: now() }, fn);
  const settle = () => (h as PrepareHarness).worker.idle();
  const newPosting = (company = 'Acme AI') => {
    const id = seedPosting(
      t.db,
      form([
        spec('Email', 'text', { meaning: 'email', required: true }),
        spec(WHY, 'textarea', { meaning: 'question', required: true }),
      ]),
      { now: now(), matches: [{ text: 'Python', factIds: [] }] },
    );
    t.db
      .update(postings)
      .set({ company, extraction: EXTRACTION, extractionKey: 'k' })
      .where(eq(postings.id, id))
      .run();
    return id;
  };
  const prepare = (postingId: number) => tx((x) => ensureApplication(x, postingId, 'test').app.id);
  const writerPrompts = () =>
    (h as PrepareHarness).claude.requests
      .filter((r) => r.role === 'application_writer')
      .map((r) => r.prompt);
  const acme = () => findCompany(t.db, 'Acme AI');

  it('researches the company once while preparing; answers wait for it and use it', async () => {
    const s = await start();
    const pid = newPosting('Acme AI, Inc.');
    prepare(pid);
    await settle();

    // One researcher run, with web search, told which company by its postings.
    expect(researched).toHaveLength(1);
    const req = researched[0];
    expect(req?.role).toBe('researcher');
    expect(req?.webSearch).toBe(true);
    expect(req?.prompt).toContain('Company: Acme AI, Inc.');
    expect(req?.prompt).toContain('Senior AI Engineer · https://jobs.example.test/acme/');

    // Stored, sourced: the non-URL source is dropped.
    const row = acme();
    expect(row).toMatchObject({ key: 'acme ai', status: 'done', trigger: 'prepare' });
    expect(row?.profile?.funding[0]?.sources).toEqual(['https://news.example.test/acme-series-a']);
    expect(row?.researchedAt).not.toBeNull();

    // The writer ran once, after the research, with the company's summary.
    const prompts = writerPrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('About Acme AI, Inc. (company research');
    expect(prompts[0]).toContain(RESEARCH.summary);
    expect(prompts[0]).toContain('- Launched a German-language model in July 2026.');
    expect(s.claude.requests.length).toBeGreaterThan(0);

    // The red flag re-scored the posting: a soft company component.
    const posting = t.db.select().from(postings).where(eq(postings.id, pid)).get();
    const company = posting?.breakdown?.find((c) => c.key === 'company');
    expect(company).toMatchObject({ value: 0.6, note: '1 red flag: layoffs (high)' });
    expect(company?.weight).toBeGreaterThan(0);
    expect(posting?.score).toBeGreaterThan(0);
    expect(posting?.score).toBeLessThan(100);
  });

  it('reuses a fresh profile, and refreshes an old one without holding preparation up', async () => {
    await start();
    prepare(newPosting());
    await settle();
    expect(researched).toHaveLength(1);

    // Another posting of the same company, the same week: no new research.
    prepare(newPosting('ACME AI'));
    await settle();
    expect(researched).toHaveLength(1);
    expect(writerPrompts()).toHaveLength(2);
    expect(writerPrompts()[1]).toContain(RESEARCH.summary);

    // A month later the profile is stale: research runs again, the answers don't wait for it
    // (they're written from the profile there is).
    t.db
      .update(companies)
      .set({ researchedAt: new Date(Date.now() - FRESH_MS - 60_000) })
      .run();
    prepare(newPosting('Acme AI GmbH'));
    await settle();
    expect(researched).toHaveLength(2);
    expect(writerPrompts()).toHaveLength(3);
    expect(listCompanies(t.db, now())).toHaveLength(1);
    expect(listCompanies(t.db, now())[0]?.postings).toHaveLength(3);
  });

  it('a failed research never blocks preparation, and is not asked again the same day', async () => {
    reply = () => ({ kind: 'error', message: 'codex: network down', usage: null });
    await start();
    const app = prepare(newPosting());
    await settle();
    expect(researched).toHaveLength(1);
    expect(acme()).toMatchObject({
      status: 'failed',
      note: 'research failed: codex: network down',
    });
    // Answers were written without company research.
    expect(writerPrompts()).toHaveLength(1);
    expect(writerPrompts()[0]).not.toContain('company research');
    const stage = t.db.select().from(tasks).where(eq(tasks.kind, 'prepare_application')).all();
    expect(stage.every((x) => x.status === 'done')).toBe(true);
    expect(app).toBeGreaterThan(0);

    prepare(newPosting('Acme AI Ltd'));
    await settle();
    expect(researched).toHaveLength(1);
  });

  it('Company research on demand: a fresh profile is kept unless refreshed', async () => {
    await start();
    const first = tx((x) => requestResearch(x, 'Acme AI', { trigger: 'manual' }));
    expect(first.queued).toBe(true);
    // Not twice while it waits.
    expect(tx((x) => requestResearch(x, 'Acme AI', { trigger: 'manual' })).queued).toBe(false);
    await settle();
    expect(acme()?.status).toBe('done');
    expect(tx((x) => requestResearch(x, 'acme ai', { trigger: 'manual' })).queued).toBe(false);
    expect(
      tx((x) => requestResearch(x, 'Acme AI', { trigger: 'manual', refresh: true })).queued,
    ).toBe(true);
    await settle();
    expect(researched).toHaveLength(2);
  });

  it("the RPCs: research a posting's company, then its profile with every source", async () => {
    const hh = await start();
    const rpc = companyRpcs({ db: t.db, bus: hh.bus, now });
    const pid = newPosting();
    const res = await rpc.researchCompany(
      create(ResearchCompanyRequestSchema, {
        target: { case: 'postingId', value: BigInt(pid) },
        refresh: false,
      }),
      {} as never,
    );
    expect(res.queued).toBe(true);
    expect(res.company?.researching).toBe(true);
    await settle();
    const got = await rpc.getCompany(
      create(GetCompanyRequestSchema, { target: { case: 'postingId', value: BigInt(pid) } }),
      {} as never,
    );
    const c = got.company as Company | undefined;
    expect(c).toMatchObject({ name: 'Acme AI', status: 'done', fresh: true, findings: 5 });
    expect(c?.summary).toBe(RESEARCH.summary);
    expect(c?.redFlags.map((f) => [f.kind, f.severity, f.sources])).toEqual([
      ['layoffs', 'high', ['https://layoffs.example.test/acme']],
    ]);
    expect(c?.sections.map((x) => x.label)).toEqual([
      'Product',
      'Funding',
      'Stack',
      'News',
      'Layoffs',
    ]);
    expect(c?.postings.map((p) => Number(p.id))).toEqual([pid]);
    const list = (await rpc.listCompanies(
      create(ListCompaniesRequestSchema, {}),
      {} as never,
    )) as ListCompaniesResponse;
    // The list leaves the sections out.
    expect(list.companies.map((x) => [x.name, x.sections.length, x.redFlags.length])).toEqual([
      ['Acme AI', 0, 1],
    ]);
  });
});

describe('research output', () => {
  it('every finding and red flag needs a source URL', () => {
    expect(validateResearch(RESEARCH)).toBeNull();
    expect(
      validateResearch({
        ...RESEARCH,
        news: [{ text: 'Rumoured acquisition.', date: null, sources: ['a friend'] }],
      }),
    ).toBe('news[0] ("Rumoured acquisition.") has no source URL');
    expect(
      validateResearch({
        ...RESEARCH,
        redFlags: [{ kind: 'reviews', severity: 'medium', text: 'Bad reviews', sources: [] }],
      }),
    ).toBe('redFlags[0] ("Bad reviews") has no source URL');
    expect(validateResearch({ ...RESEARCH, summary: ' ' })).toBe('summary is empty');
    const n = normaliseResearch({
      ...RESEARCH,
      product: [
        { text: ' A ', date: null, sources: [' https://a.example/x ', 'https://a.example/x'] },
      ],
    });
    expect(n.product).toEqual([{ text: 'A', date: null, sources: ['https://a.example/x'] }]);
  });

  it('source URLs lose tracking parameters, and the copies they made merge', () => {
    // Seen in real researcher output (Grafana Labs, 2026-09-29).
    expect(
      cleanSourceUrl(
        'https://job-boards.greenhouse.io/grafanalabs/jobs/6092955004?gh_src=Lead+Edge+Capital+job+board',
      ),
    ).toBe('https://job-boards.greenhouse.io/grafanalabs/jobs/6092955004');
    expect(cleanSourceUrl('https://grafana.com/careers/?pg=oss-oncall&plcmt=contrib-cta')).toBe(
      'https://grafana.com/careers/',
    );
    expect(cleanSourceUrl('https://x.example/a?id=7&utm_source=openai&UTM_Medium=x')).toBe(
      'https://x.example/a?id=7',
    );
    // Meaningful parameters and fragments stay, and a clean URL is returned as written.
    expect(cleanSourceUrl('https://x.example/list?pg=2')).toBe('https://x.example/list?pg=2');
    expect(cleanSourceUrl('https://x.example/a?b=1#c')).toBe('https://x.example/a?b=1#c');
    expect(cleanSourceUrl(' not a url ')).toBe('not a url');
    const n = normaliseResearch({
      ...RESEARCH,
      remote: [
        {
          text: 'Fully remote.',
          date: null,
          sources: [
            'https://grafana.com/careers/?pg=oss-oncall&plcmt=contrib-cta',
            'https://grafana.com/careers/?utm_source=openai',
          ],
        },
      ],
    });
    expect(n.remote[0]?.sources).toEqual(['https://grafana.com/careers/']);
  });

  it('one company, however its postings write the name', () => {
    expect(companyKey('Acme AI, Inc.')).toBe('acme ai');
    expect(companyKey('ACME AI GmbH')).toBe('acme ai');
    expect(companyKey('Acme AI Ltd.')).toBe('acme ai');
    expect(companyKey('Zürich Labs AG')).toBe('zurich labs');
    expect(companyKey('Smith & Co')).toBe('smith and co');
    expect(companyKey('  ')).toBe('');
    expect(companyKey(null)).toBe('');
  });
});
