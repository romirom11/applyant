// The 0–100 score: a pure function over what the extractor and matcher found once.
// Same input → same output. No I/O, no model calls, so re-scoring after a preference or
// feedback change is instant.
//
//   score = Σ weight·value·scale / Σ weight   over components that apply and are known
//
// - Core fit = must-haves × role fit. Logistics (location, remote, salary, language,
//   employment) count in full only once core fit reaches CORE_FIT_FULL; below it their
//   scale falls off quadratically, so a remote, well-paid role you can't do still scores low.
//   The weights stay in the denominator: the logistics can't be renormalised away either.
// - A component the candidate has no preference for has weight 0.
// - A component the posting doesn't say enough about is "uncertain": shown, not counted.
// - Deviations cost in proportion to how far off they are (salary 17% below costs more than 5%).
// - Dealbreakers are flags the candidate chose; they never zero the score.
// - Out of reach: a role the candidate can't take from where they are (remote only in other
//   countries, offices only where they don't want to work, in every location it is listed
//   in) is capped at OUT_OF_REACH_CAP. The location component says so. A role listed in
//   several places counts its best one.
// - Company red flags (phase 12) are a soft component: it counts only when research found
//   flags, costs in proportion to their severity and never goes below COMPANY_FLOOR, so a
//   flagged company lowers the score but can't sink it.
import type { PostingExtraction, RemoteRegion, Seniority } from '../../models/schemas/posting.ts';
import type { CompanyScoreInfo } from '../companies/store.ts';
import type { FxRates } from './fx.ts';
import { convert } from './fx.ts';
import type { CefrLevel, Preferences } from './prefs.ts';
import { listedPlace, regionCovers } from './regions.ts';
import { formatMoney, formatRange, type Money, normaliseSalary, perPeriod } from './salary.ts';
import {
  type Component,
  type ComponentKey,
  LOGISTICS_KEYS,
  type RequirementMatch,
  type ScoreResult,
  type Weights,
} from './types.ts';

export interface ScoreInput {
  posting: PostingExtraction;
  matches: RequirementMatch[];
  /** Cached reference rates; null = only same-currency salaries are comparable. */
  fx: FxRates | null;
  /** Where the posting's listings say it is (a role listed per country has several). */
  locations?: string[] | null;
  /** The company's research: its red flags. Null/absent = not researched. */
  company?: CompanyScoreInfo | null;
}

/** Salary value = 1 − SALARY_SLOPE × shortfall: 5% below → 0.88, 17% → 0.58, 40% → 0. */
export const SALARY_SLOPE = 2.5;
/** Score when nothing at all can be compared. */
export const NOTHING_KNOWN = 50;
/** The highest score a role out of the candidate's reach can get. */
export const OUT_OF_REACH_CAP = 30;
/** Core fit at or above this lets logistics count in full. */
export const CORE_FIT_FULL = 0.7;
/** What one red flag costs the company component (1 = no flags). */
export const RED_FLAG_COST = { high: 0.4, medium: 0.2, low: 0.1 } as const;
/** The company component never goes below this, however many flags. */
export const COMPANY_FLOOR = 0.2;

/** The share of logistics that counts for a core fit: (fit / CORE_FIT_FULL)², capped at 1. */
export function logisticsScale(coreFit: number | null): number {
  if (coreFit === null) return 1;
  return Math.min(1, (coreFit / CORE_FIT_FULL) ** 2);
}

type Part = Omit<Component, 'weight'> & { applies: boolean };

export function score(input: ScoreInput, prefs: Preferences, w: Weights): ScoreResult {
  const dealbreakers: string[] = [];
  const hard = (d: Preferences['dealbreakers'][number], text: string) => {
    if (prefs.dealbreakers.includes(d)) dealbreakers.push(text);
  };
  const p = input.posting;

  const parts: Part[] = [
    requirementsPart(
      'must',
      input.matches.filter((m) => m.must),
    ),
    requirementsPart(
      'nice',
      input.matches.filter((m) => !m.must),
    ),
    rolePart(p, prefs, hard),
    locationPart(p, prefs, hard, input.locations ?? []),
    remotePart(p, prefs, hard),
    salaryPart(p, prefs, input.fx, (text) => dealbreakers.push(text)),
    languagePart(p, prefs, hard),
    employmentPart(p, prefs, hard),
    companyPart(input.company ?? null),
  ];

  const counted = (c: Part) => c.applies && !c.uncertain;
  const byKey = (k: ComponentKey) => parts.find((c) => c.key === k && counted(c));
  const must = byKey('must');
  const role = byKey('role');
  const coreFit =
    must && role ? must.value * role.value : must ? must.value : role ? role.value : null;
  const scale = round2(logisticsScale(coreFit));

  const breakdown: Component[] = parts.map(({ applies, ...c }) => {
    const scaled = LOGISTICS_KEYS.includes(c.key) && applies && !c.uncertain && scale < 1;
    return {
      ...c,
      weight: applies ? w[c.key] : 0,
      value: round2(c.value),
      scale: scaled ? scale : 1,
      note: scaled
        ? `${c.note ?? ''} · counts ×${scale}: core fit ${Math.round((coreFit ?? 0) * 100)}%`
        : c.note,
    };
  });
  let total = 0;
  let sum = 0;
  for (const c of breakdown) {
    if (c.weight <= 0 || c.uncertain) continue;
    total += c.weight;
    sum += c.weight * c.value * c.scale;
  }
  let result = total > 0 ? Math.round((100 * sum) / total) : NOTHING_KNOWN;
  const where = breakdown.find((c) => c.key === 'location');
  if (where && where.weight > 0 && !where.uncertain && where.value === 0) {
    if (result > OUT_OF_REACH_CAP) {
      where.note = `${where.note ?? ''} · out of your reach: score capped at ${OUT_OF_REACH_CAP}`;
    }
    result = Math.min(result, OUT_OF_REACH_CAP);
  }
  return {
    score: Math.max(0, Math.min(100, result)),
    coreFit: coreFit === null ? null : round2(coreFit),
    breakdown,
    dealbreakers,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const part = (
  key: ComponentKey,
  applies: boolean,
  value: number,
  note: string | null,
  uncertain = false,
): Part => ({ key, applies, value, note, uncertain, scale: 1 });

// ---- requirements ---------------------------------------------------------------------

const VERDICT_VALUE = { strong: 1, partial: 0.5, missing: 0 } as const;

function requirementsPart(key: 'must' | 'nice', all: RequirementMatch[]): Part {
  // Conditions (travel, time zones, …) can't be shown by facts: asked, not counted.
  const matches = all.filter((m) => m.verdict !== 'unknown');
  const ask = all.length - matches.length;
  const toAsk = ask ? ` · ${ask} to ask you` : '';
  if (matches.length === 0) {
    if (ask) return part(key, true, 0, `only conditions to ask you (${ask})`, true);
    return part(
      key,
      true,
      0,
      key === 'must' ? 'no must-haves listed' : 'no nice-to-haves listed',
      true,
    );
  }
  const count = { strong: 0, partial: 0, missing: 0 };
  const verdicts = matches.map((m) => m.verdict as keyof typeof VERDICT_VALUE);
  for (const v of verdicts) count[v]++;
  const value = verdicts.reduce((s, v) => s + VERDICT_VALUE[v], 0) / matches.length;
  const note = (['strong', 'partial', 'missing'] as const)
    .filter((v) => count[v] > 0)
    .map((v) => `${count[v]} ${v}`)
    .join(' · ');
  return part(key, true, value, `${note} of ${matches.length}${toAsk}`);
}

// ---- role and seniority ---------------------------------------------------------------

const LEVEL: Record<Seniority, number> = {
  intern: 0,
  junior: 1,
  mid: 2,
  senior: 3,
  lead: 4,
  staff: 4,
  principal: 5,
  head: 5,
};

const FAMILY_LABEL: Record<string, string> = {
  ai_ml: 'AI/ML',
  backend: 'backend',
  fullstack: 'full-stack',
  frontend: 'frontend',
  data: 'data',
  platform: 'platform',
  mobile: 'mobile',
  security: 'security',
  founding: 'founding',
  management: 'management',
  research: 'research',
  other: 'other',
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type Hard = (d: Preferences['dealbreakers'][number], text: string) => void;

function rolePart(p: PostingExtraction, prefs: Preferences, hard: Hard): Part {
  const wantsFamily = prefs.roles.length > 0;
  const wantsLevel = prefs.seniority.length > 0;
  if (!wantsFamily && !wantsLevel) return part('role', false, 1, 'no role preferences');
  const factors: number[] = [];
  const notes: string[] = [];
  if (wantsLevel) {
    if (p.seniority === 'unknown') notes.push('seniority not stated');
    else {
      const distance = Math.min(
        ...prefs.seniority.map((s) => Math.abs(LEVEL[s] - LEVEL[p.seniority as Seniority])),
      );
      factors.push(distance === 0 ? 1 : distance === 1 ? 0.6 : 0.3);
      notes.push(
        distance === 0
          ? cap(p.seniority)
          : `${cap(p.seniority)} · you want ${prefs.seniority.join(', ')}`,
      );
      if (distance > 0) hard('seniority', `Seniority: ${p.seniority}`);
    }
  }
  if (wantsFamily) {
    const families = p.roleFamilies.map((f) => FAMILY_LABEL[f] ?? f).join(', ');
    if (p.roleFamilies.length === 0) notes.push('kind of role unclear');
    else {
      const overlap = p.roleFamilies.some((f) => prefs.roles.includes(f));
      factors.push(overlap ? 1 : 0.2);
      notes.push(overlap ? families : `${families} · not a role you're after`);
    }
  }
  if (factors.length === 0) return part('role', true, 0, notes.join(' · '), true);
  return part(
    'role',
    true,
    factors.reduce((a, b) => a * b, 1),
    notes.join(' · '),
  );
}

// ---- where ----------------------------------------------------------------------------

function scopeLabel(regions: RemoteRegion[], countries: string[]): string {
  const labels = [
    ...regions.map((r) =>
      r === 'eu' || r === 'us' || r === 'uk' ? r.toUpperCase() : r.replace('_', ' '),
    ),
    ...countries,
  ];
  return labels.join(', ');
}

function locationPart(
  p: PostingExtraction,
  prefs: Preferences,
  hard: Hard,
  listed: string[],
): Part {
  const bases = prefs.basedIn ? [prefs.basedIn] : prefs.locations;
  const officeOk = new Set([...(prefs.basedIn ? [prefs.basedIn] : []), ...prefs.locations]);
  if (bases.length === 0) return part('location', false, 1, 'no location preferences');

  // The listings' own places: the best one for the candidate counts.
  const places = listed.map((text) => ({ text, ...listedPlace(text) }));
  const reachable = places.find(
    (l) =>
      l.countries.some((c) => officeOk.has(c)) ||
      l.regions.some((r) => bases.some((b) => regionCovers(r, b))),
  );
  const placesKnown = places.some((l) => l.countries.length > 0 || l.regions.length > 0);
  const where = (base: Part): Part => {
    if (base.value === 1 && !base.uncertain) return base;
    if (reachable) {
      return part(
        'location',
        true,
        1,
        `Listed in ${reachable.text}${places.length > 1 ? ` (1 of ${places.length} locations)` : ''}`,
      );
    }
    if (!base.uncertain || !placesKnown) return base;
    const shown = places
      .slice(0, 3)
      .map((l) => l.text)
      .join('; ');
    hard('location', `Listed only in ${shown}`);
    return part('location', true, 0, `Listed only in ${shown} · not ${bases.join('/')}`);
  };
  const own = locationFromPosting(p, bases, officeOk, reachable ? () => {} : hard);
  return where(own);
}

function locationFromPosting(
  p: PostingExtraction,
  bases: string[],
  officeOk: Set<string>,
  hard: Hard,
): Part {
  const scopeKnown = p.remoteRegions.length > 0 || p.remoteCountries.length > 0;
  const offices = p.offices.filter((o) => o.country);
  const asRemote = p.workplace === 'remote' || (p.workplace === 'unknown' && scopeKnown);
  if (asRemote) {
    if (!scopeKnown) return part('location', true, 0, 'remote, region not stated', true);
    const scope = scopeLabel(p.remoteRegions, p.remoteCountries);
    const covered = bases.some(
      (c) => p.remoteCountries.includes(c) || p.remoteRegions.some((r) => regionCovers(r, c)),
    );
    if (!covered) hard('location', `Remote only in ${scope}`);
    return part(
      'location',
      true,
      covered ? 1 : 0,
      covered ? `Remote (${scope})` : `Remote only in ${scope} · not ${bases.join('/')}`,
    );
  }
  if (offices.length === 0) return part('location', true, 0, 'office location not stated', true);
  const where = offices
    .slice(0, 3)
    .map((o) => [o.city, o.country].filter(Boolean).join(', '))
    .join('; ');
  const ok = offices.some((o) => officeOk.has(o.country as string));
  if (!ok) hard('location', `Office in ${where}`);
  return part('location', true, ok ? 1 : 0, `Office in ${where}`);
}

const WORKPLACE_VALUE = {
  required: { remote: 1, hybrid: 0.3, onsite: 0 },
  preferred: { remote: 1, hybrid: 0.8, onsite: 0.6 },
} as const;

function remotePart(p: PostingExtraction, prefs: Preferences, hard: Hard): Part {
  if (prefs.remote === 'any') return part('remote', false, 1, 'no preference');
  if (p.workplace === 'unknown') return part('remote', true, 0, 'remote policy not stated', true);
  const label = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site' }[p.workplace];
  if (p.workplace !== 'remote') hard('onsite', `${label}, no remote option`);
  const value = WORKPLACE_VALUE[prefs.remote][p.workplace];
  return part(
    'remote',
    true,
    value,
    value < 1
      ? `${label} · you want ${prefs.remote === 'required' ? 'remote only' : 'remote'}`
      : label,
  );
}

// ---- salary ---------------------------------------------------------------------------

function inUnit(m: Money, unit: Money, fx: FxRates | null): number | null {
  return convert(perPeriod(m.amount, m.period, unit.period), m.currency, unit.currency, fx);
}

function salaryPart(
  p: PostingExtraction,
  prefs: Preferences,
  fx: FxRates | null,
  dealbreaker: (text: string) => void,
): Part {
  const unit = prefs.salary ?? prefs.salaryFloor;
  if (!unit) return part('salary', false, 1, 'no salary target');
  const n = normaliseSalary(p.salary, unit, fx);
  if (n.kind === 'uncertain') return part('salary', prefs.salary !== null, 0, n.reason, true);

  const shown =
    n.min !== null && n.max !== null && Math.round(n.min) !== Math.round(n.max)
      ? formatRange(n.min, n.max, n.currency, n.period)
      : formatMoney(n.offered, n.currency, n.period);
  const from = n.original ? ` (${n.original})` : '';

  if (prefs.salaryFloor) {
    const floor = inUnit(prefs.salaryFloor, unit, fx);
    if (floor !== null && n.offered < floor) {
      dealbreaker(
        `Salary below your floor (${formatMoney(n.offered, n.currency)} < ${formatMoney(floor, n.currency, n.period)})`,
      );
    }
  }
  if (!prefs.salary) return part('salary', false, 1, `Salary ${shown}${from}`);
  const target = prefs.salary.amount;
  const shortfall = (target - n.offered) / target;
  const pct = Math.round(Math.abs(shortfall) * 100);
  const value = shortfall <= 0 ? 1 : Math.max(0, 1 - SALARY_SLOPE * shortfall);
  const versus =
    pct === 0 ? 'at target' : shortfall > 0 ? `${pct}% below target` : `${pct}% above target`;
  return part('salary', true, value, `Salary ${shown}${from} · ${versus}`);
}

// ---- language -------------------------------------------------------------------------

const CEFR_RANK: Record<CefrLevel, number> = {
  A1: 1,
  A2: 2,
  B1: 3,
  B2: 4,
  C1: 5,
  C2: 6,
  native: 7,
};
const NEEDED_RANK = { basic: 2, professional: 4, fluent: 5, native: 7 } as const;
const LANGUAGE_NAME: Record<string, string> = {
  en: 'English',
  de: 'German',
  el: 'Greek',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  nl: 'Dutch',
  pl: 'Polish',
  pt: 'Portuguese',
  uk: 'Ukrainian',
  ru: 'Russian',
  cs: 'Czech',
  sv: 'Swedish',
};

function languagePart(p: PostingExtraction, prefs: Preferences, hard: Hard): Part {
  if (Object.keys(prefs.languages).length === 0)
    return part('language', false, 1, 'no languages set');
  const required = p.languages
    .filter((l) => l.required)
    .map((l) => ({ language: l.language.toLowerCase(), level: l.level }));
  const listed = new Set(p.languages.map((l) => l.language.toLowerCase()));
  const written = p.postingLanguage?.toLowerCase();
  // A posting written in a language asks for it, even when it doesn't say so.
  if (written && !listed.has(written)) required.push({ language: written, level: 'professional' });
  if (required.length === 0) return part('language', true, 1, 'no language requirements');

  let worst = { factor: 2, note: '' };
  for (const r of required) {
    const name = LANGUAGE_NAME[r.language] ?? r.language;
    const have = prefs.languages[r.language];
    const need = NEEDED_RANK[r.level ?? 'professional'];
    const factor = !have
      ? 0
      : CEFR_RANK[have] >= need
        ? 1
        : Math.max(0, 1 - 0.25 * (need - CEFR_RANK[have]));
    const note = `${name}${r.level ? ` (${r.level})` : ''} · ${have ? `you have ${have}` : "you don't list it"}`;
    if (!have) hard('language', `${name} required`);
    if (factor < worst.factor) worst = { factor, note };
  }
  return part('language', true, worst.factor, worst.note);
}

// ---- employment -----------------------------------------------------------------------

const EMPLOYMENT_LABEL: Record<string, string> = {
  full_time: 'Full-time',
  part_time: 'Part-time',
  contract: 'Contract',
  freelance: 'Freelance',
  internship: 'Internship',
  temporary: 'Temporary',
};

function employmentPart(p: PostingExtraction, prefs: Preferences, hard: Hard): Part {
  if (p.outstaffing === true) hard('outstaffing', 'Outstaffing');
  const outstaff = p.outstaffing ? ' · outstaffing' : '';
  if (prefs.employment.length === 0) {
    return part(
      'employment',
      false,
      1,
      p.employment ? `${EMPLOYMENT_LABEL[p.employment]}${outstaff}` : null,
    );
  }
  if (!p.employment)
    return part('employment', true, 0, `employment type not stated${outstaff}`, true);
  const ok = prefs.employment.includes(p.employment);
  const label = EMPLOYMENT_LABEL[p.employment] ?? p.employment;
  if (!ok) hard('employment', label);
  return part('employment', true, ok ? 1 : 0.3, `${label}${outstaff}`);
}

// ---- company --------------------------------------------------------------------------

function companyPart(company: CompanyScoreInfo | null): Part {
  if (!company) return part('company', false, 1, 'not researched');
  const flags = company.redFlags;
  if (flags.length === 0) return part('company', false, 1, 'researched · no red flags');
  const order = { high: 0, medium: 1, low: 2 } as const;
  const sorted = [...flags].sort((a, b) => order[a.severity] - order[b.severity]);
  const cost = flags.reduce((sum, f) => sum + RED_FLAG_COST[f.severity], 0);
  const value = Math.max(COMPANY_FLOOR, 1 - cost);
  const shown = sorted
    .slice(0, 3)
    .map((f) => `${f.kind} (${f.severity})`)
    .join(' · ');
  const more = flags.length > 3 ? ` · +${flags.length - 3} more` : '';
  return part(
    'company',
    true,
    value,
    `${flags.length} red flag${flags.length === 1 ? '' : 's'}: ${shown}${more}`,
  );
}
