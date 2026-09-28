// score() is pure: table tests over extractions, matches, preferences and weights.
import { describe, expect, it } from 'vitest';
import {
  effectiveWeights,
  feedbackMultipliers,
  MAX_MULTIPLIER,
  MIN_MULTIPLIER,
  reasonComponent,
  weakestComponent,
} from '../src/domain/scoring/feedback.ts';
import type { FxRates } from '../src/domain/scoring/fx.ts';
import { parseEcbXml } from '../src/domain/scoring/fx.ts';
import {
  DEFAULT_PREFERENCES,
  DEFAULT_WEIGHTS,
  PreferenceError,
  type Preferences,
  parseMoney,
  parsePreference,
} from '../src/domain/scoring/prefs.ts';
import { type ScoreInput, score } from '../src/domain/scoring/score.ts';
import type { ComponentKey, RequirementMatch } from '../src/domain/scoring/types.ts';
import type { PostingExtraction } from '../src/models/schemas/posting.ts';

const posting = (over: Partial<PostingExtraction> = {}): PostingExtraction => ({
  title: 'Senior AI Engineer',
  company: 'Acme AI',
  summary: 'Build LLM systems.',
  seniority: 'senior',
  roleFamilies: ['ai_ml', 'backend'],
  requirements: [],
  workplace: 'remote',
  remoteRegions: ['europe'],
  remoteCountries: [],
  offices: [],
  salary: {
    min: 3000,
    max: 3000,
    currency: 'EUR',
    period: 'month',
    basis: 'gross',
    text: '€3,000/month',
  },
  languages: [{ language: 'en', level: 'professional', required: true }],
  postingLanguage: 'en',
  employment: 'full_time',
  outstaffing: false,
  ...over,
});

const req = (
  text: string,
  must: boolean,
  verdict: RequirementMatch['verdict'],
): RequirementMatch => ({
  text,
  must,
  verdict,
  factIds: verdict === 'missing' ? [] : [1],
});

const allStrong: RequirementMatch[] = [
  req('Python', true, 'strong'),
  req('LLM systems', true, 'strong'),
  req('Rust', false, 'strong'),
];

const prefs = (over: Partial<Preferences> = {}): Preferences => ({
  ...DEFAULT_PREFERENCES,
  roles: ['ai_ml', 'founding'],
  seniority: ['senior', 'staff'],
  basedIn: 'GR',
  locations: ['GR', 'CY'],
  remote: 'required',
  salary: { amount: 3000, currency: 'EUR', period: 'month' },
  languages: { en: 'C1', el: 'native' },
  employment: ['full_time', 'contract'],
  ...over,
});

const RATES: FxRates = { asOf: '2026-09-25', perEur: { EUR: 1, USD: 1.25 } };

const input = (
  p: PostingExtraction,
  matches = allStrong,
  fx: FxRates | null = RATES,
): ScoreInput => ({
  posting: p,
  matches,
  fx,
});

const run = (p: PostingExtraction, pr = prefs(), matches = allStrong) =>
  score(input(p, matches), pr, pr.weights);

const component = (res: ReturnType<typeof score>, key: ComponentKey) => {
  const c = res.breakdown.find((x) => x.key === key);
  if (!c) throw new Error(`no ${key}`);
  return c;
};

const salaryAt = (amount: number) =>
  posting({
    salary: {
      min: null,
      max: amount,
      currency: 'EUR',
      period: 'month',
      basis: 'gross',
      text: `€${amount}`,
    },
  });

describe('score()', () => {
  it('a posting that meets everything scores 100, with every component explained', () => {
    const res = run(posting());
    expect(res.score).toBe(100);
    expect(res.dealbreakers).toEqual([]);
    expect(res.breakdown.map((c) => [c.key, c.weight, c.value, c.note])).toEqual([
      ['must', 35, 1, '2 strong of 2'],
      ['nice', 10, 1, '1 strong of 1'],
      ['role', 15, 1, 'Senior · AI/ML, backend'],
      ['location', 10, 1, 'Remote (europe)'],
      ['remote', 10, 1, 'Remote'],
      ['salary', 10, 1, 'Salary €3,000/month · at target'],
      ['language', 5, 1, 'English (professional) · you have C1'],
      ['employment', 5, 1, 'Full-time'],
    ]);
  });

  it('is deterministic: the same input gives the same result', () => {
    const p = posting({
      seniority: 'mid',
      workplace: 'hybrid',
      offices: [{ city: 'Berlin', country: 'DE' }],
    });
    expect(run(p)).toEqual(run(p));
  });

  it('requirements: strong 1 · partial ½ · missing 0, must and nice separately', () => {
    const res = run(posting(), prefs(), [
      req('Python', true, 'strong'),
      req('Kubernetes', true, 'partial'),
      req('Go', true, 'missing'),
      req('Rust', false, 'missing'),
    ]);
    expect(component(res, 'must')).toMatchObject({
      value: 0.5,
      note: '1 strong · 1 partial · 1 missing of 3',
    });
    expect(component(res, 'nice')).toMatchObject({ value: 0, note: '1 missing of 1' });
    // Core fit ½ (must ½ × role 1): logistics count ×(0.5/0.7)² = 0.51.
    // 35·0.5 + 10·0 + 15·1 + 40·1·0.51 over 100.
    expect(res.coreFit).toBe(0.5);
    expect(component(res, 'remote')).toMatchObject({
      scale: 0.51,
      note: 'Remote · counts ×0.51: core fit 50%',
    });
    expect(component(res, 'role').scale).toBe(1);
    expect(res.score).toBe(53);
  });

  it('perfect logistics cannot lift a poor core fit', () => {
    // iOS role for a backend/AI candidate: must-haves 35%, role fit 20%, logistics all 100%.
    const ios = posting({ roleFamilies: ['mobile'] });
    const weak = [
      req('iOS SDK', true, 'missing'),
      req('Swift', true, 'missing'),
      req('Git', true, 'partial'),
      req('CS degree', true, 'strong'),
    ];
    const res = run(ios, prefs(), weak);
    expect(component(res, 'must').value).toBe(0.38);
    expect(component(res, 'role').value).toBe(0.2);
    expect(res.coreFit).toBe(0.08);
    for (const key of ['location', 'remote', 'salary', 'language', 'employment'] as const) {
      expect(component(res, key)).toMatchObject({ value: 1, scale: 0.01 });
      expect(component(res, key).note).toMatch(/ · counts ×0\.01: core fit 8%$/);
    }
    expect(res.score).toBeLessThan(25);

    // Backend-leaning role with weak must-haves (Postgres internals): role fit 100%.
    const internals = run(posting(), prefs(), [
      req('Postgres internals', true, 'missing'),
      req('C extensions', true, 'missing'),
      req('Multi-tenant databases', true, 'strong'),
      req('Postgres at scale', true, 'partial'),
    ]);
    expect(internals.coreFit).toBe(0.38);
    expect(internals.score).toBeLessThan(45);

    // A good match keeps its logistics in full.
    const good = run(posting(), prefs(), [
      req('Python', true, 'strong'),
      req('LLM systems', true, 'strong'),
      req('Kubernetes', true, 'partial'),
      req('Rust', false, 'missing'),
    ]);
    expect(good.coreFit).toBe(0.83);
    expect(good.breakdown.every((c) => c.scale === 1)).toBe(true);
    expect(good.score).toBeGreaterThanOrEqual(80);
    expect(good.score).toBe(84);
    expect(internals.score).toBe(44);
  });

  it('salary deviations cost in proportion to how far off they are', () => {
    const at = (amount: number) => run(salaryAt(amount));
    const five = at(2850);
    const seventeen = at(2500);
    const forty = at(1800);
    expect(component(five, 'salary')).toMatchObject({
      value: 0.88,
      note: 'Salary €2,850/month · 5% below target',
    });
    expect(component(seventeen, 'salary')).toMatchObject({
      value: 0.58,
      note: 'Salary €2,500/month · 17% below target',
    });
    expect(component(forty, 'salary').value).toBe(0);
    expect(five.score).toBeGreaterThan(seventeen.score);
    expect(seventeen.score).toBeGreaterThan(forty.score);
    // A salary above target never adds more than meeting it.
    expect(component(at(4000), 'salary')).toMatchObject({
      value: 1,
      note: 'Salary €4,000/month · 33% above target',
    });
  });

  it('salary: ranges use their top, other units are converted, unknowns are uncertain', () => {
    const yearlyUsd = posting({
      salary: {
        min: 40000,
        max: 45000,
        currency: 'USD',
        period: 'year',
        basis: 'gross',
        text: '$40–45k',
      },
    });
    // 45000 USD/year → 3000 EUR/month at 1.25 USD per EUR.
    expect(component(run(yearlyUsd), 'salary')).toMatchObject({
      value: 1,
      note: 'Salary €2,667–3,000/month ($45,000/year) · at target',
    });
    const uncertain = (salary: PostingExtraction['salary']) =>
      component(run(posting({ salary })), 'salary');
    const base = {
      min: 2000,
      max: 2000,
      currency: 'EUR',
      period: 'month',
      basis: 'gross',
      text: '2000',
    } as const;
    expect(uncertain(null)).toMatchObject({ uncertain: true, note: 'no salary stated' });
    expect(uncertain({ ...base, basis: null })).toMatchObject({
      uncertain: true,
      note: 'gross or net not stated (2000)',
    });
    expect(uncertain({ ...base, basis: 'net' })).toMatchObject({ uncertain: true });
    expect(uncertain({ ...base, period: null })).toMatchObject({ uncertain: true });
    expect(uncertain({ ...base, currency: 'UAH' })).toMatchObject({
      uncertain: true,
      note: 'no exchange rate for UAH (2000)',
    });
    // Uncertain is not penalised: it simply isn't counted.
    const unknownNet = run(posting({ salary: { ...base, basis: 'net' } }));
    expect(unknownNet.score).toBe(100);
  });

  it('a dealbreaker is a flag, never a zero', () => {
    const outstaff = posting({ outstaffing: true });
    const without = run(outstaff);
    const withDealbreaker = run(outstaff, prefs({ dealbreakers: ['outstaffing'] }));
    expect(without.dealbreakers).toEqual([]);
    expect(withDealbreaker.dealbreakers).toEqual(['Outstaffing']);
    expect(withDealbreaker.score).toBe(without.score);
    expect(withDealbreaker.score).toBe(100);
    expect(component(withDealbreaker, 'employment').note).toBe('Full-time · outstaffing');
  });

  it('the salary floor is a dealbreaker only when the salary is comparable and below it', () => {
    const floor = prefs({ salaryFloor: { amount: 2000, currency: 'EUR', period: 'month' } });
    expect(run(salaryAt(1800), floor).dealbreakers).toEqual([
      'Salary below your floor (€1,800 < €2,000/month)',
    ]);
    expect(run(salaryAt(2200), floor).dealbreakers).toEqual([]);
    expect(run(posting({ salary: null }), floor).dealbreakers).toEqual([]);
    // A floor without a target: a dealbreaker check, not a score component.
    const floorOnly = prefs({
      salary: null,
      salaryFloor: { amount: 2000, currency: 'EUR', period: 'month' },
    });
    const res = run(salaryAt(1800), floorOnly);
    expect(component(res, 'salary').weight).toBe(0);
    expect(res.dealbreakers).toHaveLength(1);
  });

  it('where: remote scope against where the candidate lives, offices against locations', () => {
    const us = run(posting({ remoteRegions: ['us'] }), prefs({ dealbreakers: ['location'] }));
    expect(component(us, 'location')).toMatchObject({
      value: 0,
      note: 'Remote only in US · not GR',
    });
    expect(us.dealbreakers).toEqual(['Remote only in US']);
    expect(component(run(posting({ remoteRegions: ['worldwide'] })), 'location').value).toBe(1);
    expect(
      component(run(posting({ remoteRegions: [], remoteCountries: ['GR'] })), 'location').value,
    ).toBe(1);
    expect(component(run(posting({ remoteRegions: [] })), 'location')).toMatchObject({
      uncertain: true,
      note: 'remote, region not stated',
    });
    const office = (country: string) =>
      run(
        posting({ workplace: 'hybrid', remoteRegions: [], offices: [{ city: 'X', country }] }),
        prefs({ remote: 'preferred' }),
      );
    expect(component(office('CY'), 'location')).toMatchObject({
      value: 1,
      note: 'Office in X, CY',
    });
    expect(component(office('DE'), 'location').value).toBe(0);
  });

  it('remote: required vs preferred, on-site as a dealbreaker', () => {
    const hybrid = posting({ workplace: 'hybrid', offices: [{ city: 'Athens', country: 'GR' }] });
    expect(component(run(hybrid), 'remote')).toMatchObject({
      value: 0.3,
      note: 'Hybrid · you want remote only',
    });
    expect(component(run(hybrid, prefs({ remote: 'preferred' })), 'remote').value).toBe(0.8);
    expect(component(run(hybrid, prefs({ remote: 'any' })), 'remote').weight).toBe(0);
    expect(run(hybrid, prefs({ dealbreakers: ['onsite'] })).dealbreakers).toEqual([
      'Hybrid, no remote option',
    ]);
    expect(
      component(run(posting({ workplace: 'unknown', remoteRegions: [] })), 'remote').uncertain,
    ).toBe(true);
  });

  it('role: seniority distance and role family', () => {
    expect(component(run(posting({ seniority: 'mid' })), 'role')).toMatchObject({
      value: 0.6,
      note: 'Mid · you want senior, staff · AI/ML, backend',
    });
    expect(component(run(posting({ seniority: 'junior' })), 'role').value).toBe(0.3);
    expect(component(run(posting({ roleFamilies: ['frontend'] })), 'role').value).toBe(0.2);
    expect(
      component(run(posting({ seniority: 'unknown', roleFamilies: [] })), 'role').uncertain,
    ).toBe(true);
    expect(
      run(posting({ seniority: 'junior' }), prefs({ dealbreakers: ['seniority'] })).dealbreakers,
    ).toEqual(['Seniority: junior']);
  });

  it('language: a required language the candidate lacks, or at a lower level', () => {
    const german = posting({ languages: [{ language: 'de', level: 'fluent', required: true }] });
    expect(component(run(german), 'language')).toMatchObject({
      value: 0,
      note: "German (fluent) · you don't list it",
    });
    expect(
      component(run(german, prefs({ languages: { en: 'C1', de: 'B1' } })), 'language'),
    ).toMatchObject({
      value: 0.5,
      note: 'German (fluent) · you have B1',
    });
    expect(run(german, prefs({ dealbreakers: ['language'] })).dealbreakers).toEqual([
      'German required',
    ]);
    // A posting written in Greek asks for Greek even when it doesn't list it.
    expect(component(run(posting({ languages: [], postingLanguage: 'el' })), 'language').note).toBe(
      'Greek (professional) · you have native',
    );
  });

  it('employment: accepted types, unknown is uncertain', () => {
    expect(component(run(posting({ employment: 'part_time' })), 'employment').value).toBe(0.3);
    expect(component(run(posting({ employment: null })), 'employment').uncertain).toBe(true);
  });

  it('with no preferences, only the requirements count', () => {
    const res = score(input(posting()), DEFAULT_PREFERENCES, DEFAULT_WEIGHTS);
    expect(res.breakdown.filter((c) => c.weight > 0).map((c) => c.key)).toEqual(['must', 'nice']);
    expect(res.score).toBe(100);
    const none = score(input(posting(), []), DEFAULT_PREFERENCES, DEFAULT_WEIGHTS);
    expect(none.score).toBe(50);
  });
});

describe('feedback', () => {
  it('maps skip reasons to the component they are about', () => {
    expect(reasonComponent('salary too low')).toBe('salary');
    expect(reasonComponent('not remote')).toBe('remote');
    expect(reasonComponent('they want me to relocate to Berlin')).toBe('location');
    expect(reasonComponent('outstaffing agency')).toBe('employment');
    expect(reasonComponent('German required')).toBe('language');
    expect(reasonComponent('too junior')).toBe('role');
    expect(reasonComponent('wrong tech stack')).toBe('must');
    expect(reasonComponent('just not for me')).toBeNull();
    expect(
      weakestComponent([
        { key: 'salary', weight: 10, value: 0.4, note: null, uncertain: false, scale: 1 },
        { key: 'remote', weight: 10, value: 0.3, note: null, uncertain: true, scale: 1 },
        { key: 'must', weight: 35, value: 0.9, note: null, uncertain: false, scale: 1 },
      ]),
    ).toBe('salary');
  });

  it('nudges weights within a cap, so feedback never becomes a hard rule', () => {
    const skips = Array.from({ length: 3 }, () => ({
      kind: 'skipped' as const,
      component: 'salary',
    }));
    expect(feedbackMultipliers(skips).salary).toBe(1.3);
    const many = Array.from({ length: 100 }, () => ({
      kind: 'skipped' as const,
      component: 'salary',
    }));
    const capped = feedbackMultipliers(many);
    expect(capped.salary).toBe(MAX_MULTIPLIER);
    expect(capped.must).toBe(1);
    const interested = Array.from({ length: 100 }, () => ({
      kind: 'interested' as const,
      component: 'remote',
    }));
    expect(feedbackMultipliers(interested).remote).toBe(MIN_MULTIPLIER);
    // After the cap, later feedback still moves the weight from where it is.
    expect(feedbackMultipliers([...many, { kind: 'interested', component: 'salary' }]).salary).toBe(
      1.45,
    );

    // The most a skip streak can do to a posting that is perfect except for salary: bounded.
    const pr = prefs();
    const w = effectiveWeights(pr.weights, capped);
    expect(w.salary).toBe(15);
    const res = score(input(salaryAt(1000)), pr, w);
    expect(component(res, 'salary').value).toBe(0);
    expect(res.score).toBe(Math.round((100 * 90) / 105));
  });
});

describe('preferences', () => {
  const cur = DEFAULT_PREFERENCES;
  it('parses money in the forms people write it', () => {
    expect(parseMoney('3000 EUR/month')).toEqual({
      amount: 3000,
      currency: 'EUR',
      period: 'month',
    });
    expect(parseMoney('€3,000 per month')).toEqual({
      amount: 3000,
      currency: 'EUR',
      period: 'month',
    });
    expect(parseMoney('60k usd a year')).toEqual({
      amount: 60000,
      currency: 'USD',
      period: 'year',
    });
    expect(parseMoney('4500 CHF mth')).toEqual({ amount: 4500, currency: 'CHF', period: 'month' });
    expect(() => parseMoney('3000 per month')).toThrow(/no currency/);
    expect(() => parseMoney('3000 EUR')).toThrow(/per month or per year/);
  });

  it('validates each key and resets on an empty value', () => {
    expect(parsePreference('roles', 'ai_ml, backend,founding', cur)).toEqual({
      key: 'roles',
      value: ['ai_ml', 'backend', 'founding'],
    });
    expect(parsePreference('based_in', 'gr', cur)).toEqual({ key: 'based_in', value: 'GR' });
    expect(parsePreference('languages', 'en:c1,el:native', cur)).toEqual({
      key: 'languages',
      value: { en: 'C1', el: 'native' },
    });
    expect(parsePreference('employment', 'full-time contract', cur).value).toEqual([
      'full_time',
      'contract',
    ]);
    expect(parsePreference('weight.salary', '20', cur)).toEqual({
      key: 'weights',
      value: { ...DEFAULT_WEIGHTS, salary: 20 },
    });
    expect(parsePreference('salary', '', cur)).toEqual({ key: 'salary', value: null });
    expect(parsePreference('weights', 'reset', cur)).toEqual({ key: 'weights', value: null });
    expect(() => parsePreference('roles', 'wizard', cur)).toThrow(PreferenceError);
    expect(() => parsePreference('locations', 'Greece', cur)).toThrow(/two-letter country code/);
    expect(() => parsePreference('threshold', '120', cur)).toThrow(/0 to 100/);
    expect(() => parsePreference('colour', 'red', cur)).toThrow(/unknown preference "colour"/);
  });
});

describe('reference rates', () => {
  it('reads the ECB daily document', () => {
    const xml = `<gesmes:Envelope><Cube><Cube time='2026-09-25'>
      <Cube currency='USD' rate='1.1712'/><Cube currency='GBP' rate='0.8712'/></Cube></Cube></gesmes:Envelope>`;
    expect(parseEcbXml(xml)).toEqual({
      asOf: '2026-09-25',
      perEur: { EUR: 1, USD: 1.1712, GBP: 0.8712 },
    });
  });
});
