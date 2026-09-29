// Company red flags in score(): a soft component. It counts only when research found flags,
// lowers the score in proportion to their severity and number, and never to zero.
import { describe, expect, it } from 'vitest';
import type { CompanyScoreInfo } from '../src/domain/companies/store.ts';
import { reasonComponent } from '../src/domain/scoring/feedback.ts';
import { DEFAULT_PREFERENCES, type Preferences } from '../src/domain/scoring/prefs.ts';
import { COMPANY_FLOOR, RED_FLAG_COST, score } from '../src/domain/scoring/score.ts';
import type { RequirementMatch } from '../src/domain/scoring/types.ts';
import type { RedFlag } from '../src/models/schemas/company.ts';
import type { PostingExtraction } from '../src/models/schemas/posting.ts';

const posting: PostingExtraction = {
  title: 'Senior AI Engineer',
  company: 'Acme AI',
  summary: 'Build LLM systems.',
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

const prefs: Preferences = {
  ...DEFAULT_PREFERENCES,
  roles: ['ai_ml'],
  seniority: ['senior'],
  basedIn: 'GR',
  remote: 'required',
  languages: { en: 'C1' },
};

const matches = (strong: number, missing: number): RequirementMatch[] => [
  ...Array.from({ length: strong }, (_, i) => ({
    text: `skill ${i}`,
    must: true,
    verdict: 'strong' as const,
    factIds: [i + 1],
  })),
  ...Array.from({ length: missing }, (_, i) => ({
    text: `gap ${i}`,
    must: true,
    verdict: 'missing' as const,
    factIds: [],
  })),
];

const flag = (severity: RedFlag['severity'], kind: RedFlag['kind'] = 'layoffs') => ({
  kind,
  severity,
  text: `${kind} (${severity})`,
});

const run = (company: CompanyScoreInfo | null, m = matches(3, 0)) =>
  score({ posting, matches: m, fx: null, company }, prefs, prefs.weights);

const companyOf = (res: ReturnType<typeof run>) => {
  const c = res.breakdown.find((x) => x.key === 'company');
  if (!c) throw new Error('no company component');
  return c;
};

describe('company red flags in the score', () => {
  it('does not count before research, or when research found nothing', () => {
    const none = run(null);
    const clean = run({ name: 'Acme AI', redFlags: [] });
    expect(companyOf(none)).toMatchObject({ weight: 0, note: 'not researched' });
    expect(companyOf(clean)).toMatchObject({ weight: 0, note: 'researched · no red flags' });
    // Research that finds nothing never raises or lowers a score.
    expect(clean.score).toBe(none.score);
    expect(none.score).toBe(100);
  });

  it('a red flag lowers the score, in proportion to its severity', () => {
    const base = run(null).score;
    const low = run({ name: 'Acme AI', redFlags: [flag('low')] });
    const medium = run({ name: 'Acme AI', redFlags: [flag('medium')] });
    const high = run({ name: 'Acme AI', redFlags: [flag('high')] });
    expect(low.score).toBeLessThan(base);
    expect(medium.score).toBeLessThan(low.score);
    expect(high.score).toBeLessThan(medium.score);
    expect(companyOf(high)).toMatchObject({
      weight: prefs.weights.company,
      value: 1 - RED_FLAG_COST.high,
      uncertain: false,
      note: '1 red flag: layoffs (high)',
    });
    // Soft: one high flag on an otherwise perfect match still leaves a strong score.
    expect(high.score).toBeGreaterThanOrEqual(90);
    // Flags are soft signals, never dealbreakers.
    expect(high.dealbreakers).toEqual([]);
  });

  it('more flags cost more, down to a floor: never to zero', () => {
    const one = run({ name: 'Acme AI', redFlags: [flag('high')] });
    const two = run({ name: 'Acme AI', redFlags: [flag('high'), flag('high', 'reviews')] });
    const many = run({
      name: 'Acme AI',
      redFlags: [
        flag('high'),
        flag('high', 'reviews'),
        flag('high', 'funding'),
        flag('medium', 'pay'),
        flag('low', 'legal'),
      ],
    });
    expect(two.score).toBeLessThan(one.score);
    expect(companyOf(many).value).toBe(COMPANY_FLOOR);
    expect(companyOf(many).note).toBe(
      '5 red flags: layoffs (high) · reviews (high) · funding (high) · +2 more',
    );
    expect(many.score).toBeGreaterThan(0);
    // The most a company can cost: its weight counted at the floor value.
    const base = run(null);
    const counted = base.breakdown
      .filter((c) => c.weight > 0 && !c.uncertain)
      .reduce((a, c) => a + c.weight, 0);
    const w = prefs.weights.company;
    const worst = Math.round((base.score * counted + 100 * w * COMPANY_FLOOR) / (counted + w));
    expect(many.score).toBe(worst);
  });

  it('never zeroes a weak match either', () => {
    const weak = run(
      { name: 'Acme AI', redFlags: [flag('high'), flag('high'), flag('high')] },
      matches(1, 3),
    );
    expect(weak.score).toBeGreaterThan(0);
  });

  it('a skip about the company nudges the company weight', () => {
    expect(reasonComponent('they just had layoffs')).toBe('company');
    expect(reasonComponent('bad Glassdoor reviews')).toBe('company');
    // Earlier patterns still win: this is about salary.
    expect(reasonComponent('salary too low')).toBe('salary');
  });
});
