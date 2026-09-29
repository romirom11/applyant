// One posting per role: exact keys (URL, ATS id, company + title), MinHash for reposts,
// embeddings only for MinHash's grey zone, and the guards that keep distinct jobs apart.
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { postingSources, postings, strategyPostings } from '../src/db/schema.ts';
import {
  type Candidate,
  companyKey,
  DedupeIndex,
  minhash,
  minhashSimilarity,
  titleKey,
  titleSimilarity,
} from '../src/domain/search/dedupe.ts';
import type { Listing } from '../src/domain/search/readers/types.ts';
import { addSource } from '../src/domain/search/sources.ts';
import type { Embedder } from '../src/models/embeddings.ts';
import { type TempDb, tempDb } from './helpers/db.ts';
import { recordedFetch, type SearchHarness, searchHarness } from './helpers/search.ts';

const now = new Date('2026-09-28T10:00:00Z');

// A made-up role description, long enough for shingles.
const WORDS =
  'acme builds retrieval systems for hospitals and you will own the ingestion pipeline the evaluation harness and the serving layer working with python typescript postgres and pgvector we ship small changes daily review each other and care about latency accuracy and the people who read our answers you will pair with clinicians design experiments write the migration plan for the vector store mentor two engineers run the on call rotation for the model gateway and talk to customers about what the system can and cannot do we offer remote work across europe a learning budget four weeks of holiday equity and a salary between seventy and ninety thousand euro depending on experience the interview has four steps a call with the founder a take home exercise a system design conversation and a final chat with the team'.split(
    ' ',
  );
const DESCRIPTION = WORDS.join(' ');

function listing(p: Partial<Listing> & { url: string; title: string }): Listing {
  return {
    sourceUrl: p.url,
    externalId: null,
    company: null,
    location: null,
    remote: null,
    team: null,
    description: null,
    applyUrl: null,
    postedAt: null,
    ...p,
  };
}

describe('keys', () => {
  it('normalises companies and titles', () => {
    expect(companyKey('Acme AI, Inc.')).toBe('acme ai');
    expect(companyKey('ACME AI GmbH')).toBe('acme ai');
    expect(companyKey('Modash.io')).toBe('modash');
    expect(companyKey('Škoda Labs')).toBe('skoda labs');
    expect(titleKey('Senior AI/ML Engineer — Remote')).toBe('senior ai ml engineer remote');
    expect(titleSimilarity('Senior AI Engineer', 'AI Engineer (Senior)')).toBe(1);
    expect(titleSimilarity('Senior AI Engineer', 'Office Manager')).toBe(0);
  });

  it('MinHash estimates how much two descriptions share', () => {
    const a = minhash(DESCRIPTION);
    const same = minhash(`${DESCRIPTION} apply today`);
    const half = minhash(
      [
        ...WORDS.slice(0, 100),
        ...'we are a logistics company in rotterdam hiring warehouse staff for night shifts with forklift licences and a strong safety record'.split(
          ' ',
        ),
      ].join(' '),
    );
    expect(a).toHaveLength(64);
    expect(minhashSimilarity(a, same)).toBeGreaterThanOrEqual(0.8);
    expect(minhashSimilarity(a, half)).toBeLessThan(0.8);
    expect(
      minhashSimilarity(
        a,
        minhash('an unrelated text about gardening tools and soil ph levels in spring'),
      ),
    ).toBeLessThan(0.2);
    // Too little text to compare.
    expect(minhash('Senior AI Engineer')).toBeNull();
  });
});

describe('the dedupe plan', () => {
  let t: TempDb;
  beforeEach(() => {
    t = tempDb();
  });
  afterEach(() => t.cleanup());

  const known = (p: Partial<typeof postings.$inferInsert> & { canonicalUrl: string }) =>
    t.db
      .insert(postings)
      .values({ stage: 'scored', firstSeenAt: now, ...p })
      .returning()
      .get().id;
  const c = (l: Listing, sourceId = 1): Candidate => ({ listing: l, sourceId });

  it('matches by URL, by ATS id and by company + title', async () => {
    const byUrl = known({
      canonicalUrl: 'https://acme.example/jobs/1',
      title: 'Backend Engineer',
      company: 'Acme',
    });
    const byAts = known({
      canonicalUrl: 'https://job-boards.greenhouse.io/acme/jobs/4001',
      atsKey: 'greenhouse:4001',
      title: 'Senior AI Engineer',
      company: 'Acme AI',
    });
    const byName = known({
      canonicalUrl: 'https://lumen.example/careers/7',
      title: 'Data Engineer',
      company: 'Lumen Health',
    });
    const plan = await DedupeIndex.load(t.db).plan([
      c(
        listing({
          url: 'https://acme.example/jobs/1?utm_source=hn#apply',
          title: 'Backend Engineer',
        }),
      ),
      c(
        listing({
          url: 'https://remoteok.com/remote-jobs/9',
          applyUrl: 'https://boards.greenhouse.io/acme/jobs/4001',
          title: 'AI Engineer',
          company: 'Acme',
        }),
      ),
      c(
        listing({
          url: 'https://weworkremotely.com/remote-jobs/lumen-data',
          title: 'Data Engineer',
          company: 'Lumen Health, Inc.',
        }),
      ),
      c(listing({ url: 'https://new.example/jobs/1', title: 'Designer', company: 'New Co' })),
    ]);
    expect(plan.map((p) => [p.postingId, p.matchedBy])).toEqual([
      [byUrl, 'url'],
      [byAts, 'ats'],
      [byName, 'company_title'],
      [null, 'new'],
    ]);
  });

  it('a repost with the same description joins its posting (MinHash); a different role does not', async () => {
    const ats = known({
      canonicalUrl: 'https://job-boards.greenhouse.io/acme/jobs/4001',
      atsKey: 'greenhouse:4001',
      title: 'Senior AI Engineer',
      company: 'Acme AI',
      minhash: minhash(DESCRIPTION),
    });
    const plan = await DedupeIndex.load(t.db).plan([
      // The company's WWR ad: another URL, no ATS link, the same text.
      c(
        listing({
          url: 'https://weworkremotely.com/remote-jobs/acme-ai-senior-ai-engineer',
          title: 'Senior AI Engineer (Remote EU)',
          company: 'Acme AI',
          description: `${DESCRIPTION} apply today`,
        }),
      ),
      // Same boilerplate, different job: the title keeps them apart.
      c(
        listing({
          url: 'https://weworkremotely.com/remote-jobs/acme-ai-office-manager',
          title: 'Office Manager',
          company: 'Acme AI',
          description: DESCRIPTION,
        }),
      ),
    ]);
    expect(plan.map((p) => [p.postingId, p.matchedBy])).toEqual([
      [ats, 'minhash'],
      [null, 'new'],
    ]);
  });

  it('the grey zone asks the embeddings, and only then', async () => {
    const id = known({
      canonicalUrl: 'https://acme.example/careers/ai',
      title: 'Senior AI Engineer',
      company: 'Acme AI',
      minhash: minhash(DESCRIPTION),
      listingText: DESCRIPTION,
    });
    const variant = [
      ...WORDS.slice(0, 115),
      ...'we also expect you to present at conferences publish papers with our research partners and help recruit the next three members of the applied science group based in berlin'.split(
        ' ',
      ),
    ].join(' ');
    const sim = minhashSimilarity(minhash(DESCRIPTION), minhash(variant));
    expect(sim).toBeGreaterThanOrEqual(0.5);
    expect(sim).toBeLessThan(0.8);
    const embedder = (same: boolean): Embedder & { calls: number } => {
      const e = {
        id: 'stub',
        calls: 0,
        async embed(texts: string[]) {
          e.calls++;
          return texts.map((_, i) => Float32Array.from(same || i === 0 ? [1, 0] : [0, 1]));
        },
      };
      return e;
    };
    // A nearby title (not the same one, which would match exactly) and a partly shared text.
    const l = listing({
      url: 'https://remotive.com/remote-jobs/acme-ai',
      title: 'Senior AI Engineer, Applied Science',
      company: 'Acme AI',
      description: variant,
    });
    const yes = embedder(true);
    expect(
      (await DedupeIndex.load(t.db).plan([c(l)], { embedder: yes, textOf: () => DESCRIPTION }))[0],
    ).toMatchObject({ postingId: id, matchedBy: 'embedding' });
    const no = embedder(false);
    expect(
      (await DedupeIndex.load(t.db).plan([c(l)], { embedder: no, textOf: () => DESCRIPTION }))[0],
    ).toMatchObject({ postingId: null, matchedBy: 'new' });
    expect([yes.calls, no.calls]).toEqual([1, 1]);
    // A sure MinHash match never asks.
    const sure = embedder(false);
    await DedupeIndex.load(t.db).plan([c({ ...l, description: DESCRIPTION })], { embedder: sure });
    expect(sure.calls).toBe(0);
  });

  it('two ATS ids, or two ids from one source, are two postings even with the same title', async () => {
    const plan = await DedupeIndex.load(t.db).plan([
      c(
        listing({
          url: 'https://job-boards.greenhouse.io/acme/jobs/1',
          externalId: '1',
          title: 'Backend Engineer',
          company: 'Acme',
          description: DESCRIPTION,
        }),
      ),
      c(
        listing({
          url: 'https://job-boards.greenhouse.io/acme/jobs/2',
          externalId: '2',
          title: 'Backend Engineer',
          company: 'Acme',
          description: DESCRIPTION,
        }),
      ),
      c(
        listing({
          url: 'https://www.arbeitnow.com/jobs/companies/databricks/hesse-98802',
          externalId: 'hesse-98802',
          title: 'Lakebase Sales Specialist, Associate Director (Germany)',
          company: 'databricks',
        }),
        2,
      ),
      c(
        listing({
          url: 'https://www.arbeitnow.com/jobs/companies/databricks/munich-458987',
          externalId: 'munich-458987',
          title: 'Lakebase Sales Specialist, Associate Director (Germany)',
          company: 'databricks',
        }),
        2,
      ),
      // …while another source listing the first one by title joins it.
      c(
        listing({
          url: 'https://remotive.com/remote-jobs/x-1',
          externalId: 'x-1',
          title: 'Lakebase Sales Specialist, Associate Director (Germany)',
          company: 'Databricks',
        }),
        3,
      ),
    ]);
    expect(plan.map((p) => p.matchedBy)).toEqual(['new', 'new', 'new', 'new']);
    expect(plan[2]?.candidates).toHaveLength(2);
  });
});

describe("a company board's per-country copies of one role", () => {
  let t: TempDb;
  beforeEach(() => {
    t = tempDb();
  });
  afterEach(() => t.cleanup());

  // Grafana Labs on Greenhouse (the 2026-09-29 check): one opening per country, each with its
  // own job id, the country in the title, and the same description.
  const copy = (id: string, country: string, description = DESCRIPTION) =>
    listing({
      url: `https://job-boards.greenhouse.io/grafanalabs/jobs/${id}`,
      externalId: id,
      title: `Senior Backend Engineer - Databases - Loki Query | ${country} | Remote`,
      company: 'Grafana Labs',
      location: `${country} (Remote)`,
      description,
    });
  const board = (l: Listing, companyBoard = true): Candidate => ({
    listing: l,
    sourceId: 1,
    companyBoard,
  });

  it('become one posting carrying every location, titled without the place', async () => {
    const plan = await DedupeIndex.load(t.db).plan([
      board(copy('101', 'UK')),
      board(copy('102', 'Germany')),
      board(copy('103', 'Spain')),
      board(copy('104', 'Sweden')),
    ]);
    expect(plan).toHaveLength(1);
    expect(plan[0]?.candidates.map((c) => c.listing.externalId)).toEqual([
      '101',
      '102',
      '103',
      '104',
    ]);
    expect(plan[0]?.locations).toEqual([
      'UK (Remote)',
      'Germany (Remote)',
      'Spain (Remote)',
      'Sweden (Remote)',
    ]);
    expect(plan[0]?.roleTitle).toBe('Senior Backend Engineer - Databases - Loki Query');
    expect(plan[0]?.atsKey).toBe('greenhouse:101');
  });

  it('stay apart on a job board, with another description, or another role', async () => {
    const other = [...WORDS].reverse().join(' ');
    const plan = await DedupeIndex.load(t.db).plan([
      board(copy('101', 'UK')),
      board(copy('102', 'Germany', other)),
      board(copy('103', 'Spain'), false),
      board(
        listing({
          ...copy('104', 'Sweden'),
          title: 'Senior Backend Engineer - Databases - Mimir | Sweden | Remote',
        }),
      ),
    ]);
    expect(plan.map((p) => p.matchedBy)).toEqual(['new', 'new', 'new', 'new']);
  });

  it('keep the exact keys: a later run finds each copy by its own URL', async () => {
    const t0 = new Date('2026-09-28T10:00:00Z');
    const { source: src } = addSource(t.db, { kind: 'greenhouse', locator: 'grafanalabs' }, t0);
    const id = t.db
      .insert(postings)
      .values({
        stage: 'scored',
        firstSeenAt: t0,
        canonicalUrl: 'https://job-boards.greenhouse.io/grafanalabs/jobs/101',
        title: 'Senior Backend Engineer - Databases - Loki Query',
        company: 'Grafana Labs',
        atsKey: 'greenhouse:101',
        minhash: minhash(DESCRIPTION),
        locations: ['UK (Remote)', 'Germany (Remote)'],
      })
      .returning()
      .get().id;
    for (const ext of ['101', '102']) {
      t.db
        .insert(postingSources)
        .values({
          postingId: id,
          kind: 'greenhouse',
          url: `https://job-boards.greenhouse.io/grafanalabs/jobs/${ext}`,
          firstSeenAt: t0,
          searchSourceId: src.id,
          externalId: ext,
          lastSeenAt: t0,
        })
        .run();
    }
    const plan = await DedupeIndex.load(t.db).plan([
      { ...board(copy('102', 'Germany')), sourceId: src.id },
      { ...board(copy('105', 'Ireland')), sourceId: src.id },
    ]);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ postingId: id, matchedBy: 'url' });
    expect(plan[0]?.candidates).toHaveLength(2);
  });
});

describe('the same role via a board, its ATS and the career page', () => {
  let t: TempDb;
  let h: SearchHarness | null = null;
  beforeEach(() => {
    t = tempDb();
  });
  afterEach(async () => {
    await h?.stop();
    h = null;
    t.cleanup();
  });

  it('becomes one posting with three sources', async () => {
    const fetch = recordedFetch({
      'https://boards-api.greenhouse.io/v1/boards/acmeai/jobs?content=true': {
        jobs: [
          {
            id: 4001,
            title: 'Senior AI Engineer',
            company_name: 'Acme AI',
            absolute_url: 'https://job-boards.greenhouse.io/acmeai/jobs/4001',
            location: { name: 'Remote, EU' },
            content: `&lt;p&gt;${DESCRIPTION}&lt;/p&gt;`,
          },
        ],
        meta: { total: 1 },
      },
      'https://remoteok.com/api': [
        { legal: 'RemoteOK legal notice' },
        {
          id: '900',
          position: 'Senior AI Engineer',
          company: 'Acme AI Inc.',
          url: 'https://remoteok.com/remote-jobs/900',
          apply_url: 'https://boards.greenhouse.io/acmeai/jobs/4001',
          location: 'Europe',
          description: `<p>${DESCRIPTION}</p>`,
        },
      ],
      'https://acme.example/careers': `<html><head><script type="application/ld+json">${JSON.stringify(
        {
          '@type': 'JobPosting',
          title: 'Senior AI Engineer',
          url: 'https://acme.example/careers/senior-ai-engineer?gh_jid=4001',
          hiringOrganization: { name: 'Acme AI' },
          description: DESCRIPTION,
        },
      )}</script></head><body></body></html>`,
    });
    h = searchHarness(t, { fetch, now: () => now });
    addSource(t.db, { kind: 'greenhouse', locator: 'acmeai' }, now);
    addSource(t.db, { kind: 'page', locator: 'https://acme.example/careers' }, now);
    const run = await h.run({
      name: 'AI · Remote EU',
      queries: ['ai engineer'],
      sources: ['board:remoteok', 'greenhouse:acmeai', 'page:https://acme.example/careers'],
    });
    const all = t.db.select().from(postings).all();
    expect(all).toHaveLength(1);
    const p = all[0];
    // The company's own board comes first: its job page is the posting's URL.
    expect(p).toMatchObject({
      stage: 'found',
      canonicalUrl: 'https://job-boards.greenhouse.io/acmeai/jobs/4001',
      title: 'Senior AI Engineer',
      company: 'Acme AI',
      atsKey: 'greenhouse:4001',
    });
    const links = h.links(p?.id ?? 0);
    expect(links.map((l) => [l.kind, l.url, l.externalId]).sort()).toEqual([
      ['board', 'https://remoteok.com/remote-jobs/900', '900'],
      ['greenhouse', 'https://job-boards.greenhouse.io/acmeai/jobs/4001', '4001'],
      [
        'page',
        'https://acme.example/careers/senior-ai-engineer?gh_jid=4001',
        'https://acme.example/careers/senior-ai-engineer?gh_jid=4001',
      ],
    ]);
    // Verified once, as one posting; the task carries the run.
    expect(h.tasksOf('verify_posting').map((x) => [x.entityId, x.runId])).toEqual([[p?.id, run]]);
    expect(t.db.select().from(strategyPostings).all()).toHaveLength(1);
    const results = h.runRow(run)?.results ?? [];
    expect(results.map((r) => [r.sourceKey, r.matched, r.added, r.attached])).toEqual([
      ['greenhouse:acmeai', 1, 1, 0],
      ['page:https://acme.example/careers', 1, 0, 1],
      ['board:remoteok', 1, 0, 1],
    ]);

    // The next run finds nothing new.
    const again = await h.again(1);
    expect(t.db.select().from(postings).all()).toHaveLength(1);
    expect(h.runRow(again)).toMatchObject({ added: 0, status: 'done' });
    expect(h.tasksOf('verify_posting')).toHaveLength(1);
    expect(
      t.db
        .select()
        .from(postings)
        .where(eq(postings.id, p?.id ?? 0))
        .get()?.stage,
    ).toBe('found');
  });
});
