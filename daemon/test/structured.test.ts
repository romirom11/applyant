// Regressions from the phase-3 manual check: the page's structured data and labels beat the
// model's reading; unsplit requirement lists are must-haves; conditions aren't missing skills.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReaderPool } from '../src/browser/reader-pool.ts';
import { normaliseExtraction } from '../src/domain/scoring/extract.ts';
import {
  type Candidates,
  CONDITION_NOTE,
  matchKey,
  planMatches,
} from '../src/domain/scoring/match.ts';
import { DEFAULT_PREFERENCES, type Preferences } from '../src/domain/scoring/prefs.ts';
import { score } from '../src/domain/scoring/score.ts';
import {
  applyStructured,
  countryCode,
  pageWorkplace,
  structuredFromJsonLd,
  structuredFromPage,
} from '../src/domain/scoring/structured.ts';
import { readPostingText } from '../src/domain/search/posting-text.ts';
import type { PostingExtraction } from '../src/models/schemas/posting.ts';
import { quietLog } from './helpers/deps.ts';
import { type SiteServer, startSiteServer } from './helpers/site-server.ts';

/** What a model reading the page wrongly returns for a hybrid role with a remote-work perk. */
const misread: PostingExtraction = {
  title: 'Senior Software Engineer, iOS',
  company: 'Blueground',
  summary: 'Build the iOS app.',
  seniority: 'senior',
  roleFamilies: ['mobile'],
  requirements: [{ text: 'Strong Swift skills', must: true, kind: 'skill' }],
  workplace: 'remote',
  remoteRegions: [],
  remoteCountries: [],
  offices: [],
  salary: null,
  languages: [],
  postingLanguage: 'en',
  employment: null,
  outstaffing: null,
};

const prefs: Preferences = {
  ...DEFAULT_PREFERENCES,
  basedIn: 'GR',
  locations: ['GR', 'CY'],
  remote: 'preferred',
  employment: ['full_time'],
};

describe('a hybrid posting whose benefits mention remote work', () => {
  let site: SiteServer;
  let reader: ReaderPool;
  beforeAll(async () => {
    site = await startSiteServer();
    reader = new ReaderPool({ maxContexts: 1, navigationTimeoutMs: 15_000, log: quietLog });
  });
  afterAll(async () => {
    await reader?.close();
    await site?.close();
  });

  it('is hybrid in Athens: the page label wins over the model and over TELECOMMUTE', async () => {
    const page = await reader.withPage(async (p) => {
      await p.goto(site.url('/hybrid-perk.html'));
      return readPostingText(p);
    });
    // The header keeps the labels Readability drops, as separate pieces.
    expect(page.text).toContain(
      'Page header (labels shown around the title): Blueground | Senior Software Engineer, iOS | Hybrid | Shared Services | Full time | Athens',
    );
    expect(page.text).toContain('Flexibility to work remotely through our Blueground Nomads');
    expect(pageWorkplace(page.text)).toBe('hybrid');

    const structured = structuredFromPage(page.jsonLd, page.text);
    expect(structured).toMatchObject({
      pageWorkplace: 'hybrid',
      telecommute: true,
      offices: [{ city: 'Athens', country: 'GR' }],
      applicantCountries: ['GR'],
      employment: 'full_time',
    });
    const { extraction, decided } = applyStructured(misread, structured);
    expect(extraction).toMatchObject({
      workplace: 'hybrid',
      offices: [{ city: 'Athens', country: 'GR' }],
      employment: 'full_time',
    });
    expect(decided).toEqual([
      'employment',
      'offices',
      'workplace (page label)',
      'remote countries',
    ]);

    const res = score({ posting: extraction, matches: [], fx: null }, prefs, prefs.weights);
    const c = (k: string) => res.breakdown.find((x) => x.key === k);
    expect(c('remote')).toMatchObject({ value: 0.8, note: 'Hybrid · you want remote' });
    expect(c('location')).toMatchObject({ value: 1, note: 'Office in Athens, GR' });
  });

  it('without a page label, TELECOMMUTE with an office only rules out on-site', () => {
    const node = {
      '@type': 'JobPosting',
      jobLocationType: 'TELECOMMUTE',
      jobLocation: { address: { addressCountry: 'GR', addressLocality: 'Athens' } },
    };
    const st = structuredFromJsonLd(node);
    expect(applyStructured({ ...misread, workplace: 'onsite' }, st).extraction.workplace).toBe(
      'hybrid',
    );
    expect(applyStructured({ ...misread, workplace: 'hybrid' }, st).extraction.workplace).toBe(
      'hybrid',
    );
    // TELECOMMUTE with no office at all is remote.
    const remote = structuredFromJsonLd({ ...node, jobLocation: undefined });
    expect(applyStructured({ ...misread, workplace: 'hybrid' }, remote).extraction.workplace).toBe(
      'remote',
    );
  });

  it('stated applicant countries are the remote scope, over regions read from the text', () => {
    const st = structuredFromJsonLd({
      '@type': 'JobPosting',
      jobLocationType: 'TELECOMMUTE',
      jobLocation: { address: { addressCountry: 'United Kingdom' } },
      applicantLocationRequirements: [
        { '@type': 'Country', name: 'United States' },
        { '@type': 'Country', name: 'Poland' },
      ],
    });
    // The body said "can be executed globally"; the posting's own country list decides.
    const { extraction } = applyStructured({ ...misread, remoteRegions: ['worldwide'] }, st);
    expect(extraction).toMatchObject({ remoteRegions: [], remoteCountries: ['US', 'PL'] });
    const res = score({ posting: extraction, matches: [], fx: null }, prefs, prefs.weights);
    expect(res.breakdown.find((c) => c.key === 'location')).toMatchObject({
      value: 0,
      note: 'Remote only in US, PL · not GR',
    });
  });

  it('takes salary and employment type from structured data', () => {
    const st = structuredFromJsonLd({
      '@type': 'JobPosting',
      employmentType: ['CONTRACTOR'],
      baseSalary: {
        '@type': 'MonetaryAmount',
        currency: 'eur',
        value: { '@type': 'QuantitativeValue', minValue: 70000, maxValue: 85000, unitText: 'YEAR' },
      },
    });
    const { extraction, decided } = applyStructured(misread, st);
    expect(extraction.employment).toBe('contract');
    expect(extraction.salary).toMatchObject({
      min: 70000,
      max: 85000,
      currency: 'EUR',
      period: 'year',
      basis: 'gross',
    });
    expect(decided).toEqual(['employment', 'salary']);
  });

  it('reads country names and codes, not deprecated ones', () => {
    expect(
      ['United Kingdom', 'UK', 'Serbia', 'Germany', 'Bosnia', { name: 'Greece' }].map(countryCode),
    ).toEqual(['GB', 'GB', 'RS', 'DE', 'BA', 'GR']);
    const label = (pieces: string) =>
      pageWorkplace(`x\nPage header (labels shown around the title): ${pieces}`);
    expect(label('Engineer | Location Type | Remote | Department')).toBe('remote');
    expect(label('Engineer | On-site | Full time')).toBe('onsite');
    expect(
      label('Engineer | We offer remote work flexibility for everyone | Full time'),
    ).toBeNull();
  });
});

describe('requirement lists', () => {
  const req = (text: string, must: boolean, kind: 'skill' | 'condition' = 'skill') => ({
    text,
    must,
    kind,
  });

  it('a list with no must/nice split is all must-haves', () => {
    const unsplit = normaliseExtraction({
      ...misread,
      requirements: [req('Serving ML models in production', false), req('CUDA or Triton', false)],
    });
    expect(unsplit.requirements.map((r) => r.must)).toEqual([true, true]);
    // An explicit split is kept.
    const split = normaliseExtraction({
      ...misread,
      requirements: [req('Python', true), req('Rust', false)],
    });
    expect(split.requirements.map((r) => r.must)).toEqual([true, false]);
  });

  it('conditions are asked, not counted as missing skills', () => {
    const cand = (text: string, kind: 'skill' | 'condition'): Candidates => {
      const requirement = { text, must: true, kind };
      return { requirement, facts: [], key: matchKey(requirement, []) };
    };
    const plan = planMatches(
      [cand('Willing to travel 30–50%', 'condition'), cand('Rust', 'skill')],
      null,
    );
    expect(plan.ask).toEqual([]);
    expect(plan.settled.get(0)).toMatchObject({ verdict: 'unknown', note: CONDITION_NOTE });
    expect(plan.settled.get(1)).toMatchObject({ verdict: 'missing' });

    const res = score(
      {
        posting: misread,
        matches: [
          { text: 'Python', must: true, verdict: 'strong', factIds: [1] },
          { text: 'Willing to travel 30–50%', must: true, verdict: 'unknown', factIds: [] },
        ],
        fx: null,
      },
      DEFAULT_PREFERENCES,
      DEFAULT_PREFERENCES.weights,
    );
    expect(res.breakdown.find((c) => c.key === 'must')).toMatchObject({
      value: 1,
      note: '1 strong of 1 · 1 to ask you',
    });
  });
});
