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
  type RoleVerdict,
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
  /**
   * How the posting compares with the roles the candidate is after (role-fit.ts). Null/absent:
   * not judged (yet), so the role counts on seniority alone.
   */
  roleFit?: RoleVerdict | null;
  /** The company's research: its red flags. Null/absent = not researched. */
  company?: CompanyScoreInfo | null;
}

/** Salary value = 1 − SALARY_SLOPE × shortfall: 5% below → 0.88, 17% → 0.58, 40% → 0. */
export const SALARY_SLOPE = 2.5;
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
    rolePart(p, prefs, hard, input.roleFit ?? null),
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
  let result = total > 0 ? Math.round((100 * sum) / total) : 0;
  // A posting that lists nothing to match (an empty description, only conditions) says nothing
  // about how well the candidate fits: it gets no number at all, rather than one made of the
  // title and the logistics. The breakdown still shows what could be compared.
  const musts = breakdown.find((c) => c.key === 'must');
  const unscorable = !must && !!musts;
  if (unscorable && musts) {
    musts.note = `${musts.note ?? ''} · nothing to compare with your experience, so no score: open the posting and decide yourself`;
  }
  const where = breakdown.find((c) => c.key === 'location');
  if (where && where.weight > 0 && !where.uncertain && where.value === 0) {
    if (result > OUT_OF_REACH_CAP) {
      where.note = `${where.note ?? ''} · out of your reach: score capped at ${OUT_OF_REACH_CAP}`;
    }
    result = Math.min(result, OUT_OF_REACH_CAP);
  }
  return {
    score: unscorable ? null : Math.max(0, Math.min(100, result)),
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

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type Hard = (d: Preferences['dealbreakers'][number], text: string) => void;

/** What each role verdict is worth, and how the breakdown says it. */
const ROLE_FIT: Record<RoleVerdict, { value: number; note: string }> = {
  same: { value: 1, note: "One of the roles you're after" },
  close: { value: 0.6, note: 'Close to the roles you want' },
  different: { value: 0.2, note: "Not a role you're after" },
};

function rolePart(
  p: PostingExtraction,
  prefs: Preferences,
  hard: Hard,
  roleFit: RoleVerdict | null,
): Part {
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
    if (!roleFit) notes.push('not compared with your roles yet');
    else {
      factors.push(ROLE_FIT[roleFit].value);
      notes.push(ROLE_FIT[roleFit].note);
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
  return otherCity(where(own), p, prefs);
}

/** What an office in the candidate's country, but not their city, is worth. */
export const OTHER_CITY_VALUE = 0.6;

const sameCity = (a: string, b: string) => {
  const norm = (s: string) =>
    s
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  return norm(a) === norm(b);
};

/**
 * An office job in the candidate's own country but another city means a move or a long
 * commute: it counts, for less. Remote work, an office in their city, one whose city isn't
 * stated, and offices in the other countries they named are left as they are.
 */
function otherCity(base: Part, p: PostingExtraction, prefs: Preferences): Part {
  const city = prefs.basedCity;
  if (!city || !prefs.basedIn || base.value !== 1 || base.uncertain) return base;
  if (p.workplace !== 'onsite' && p.workplace !== 'hybrid') return base;
  const offices = p.offices.filter((o) => o.country);
  const fine = offices.some(
    (o) =>
      (o.country === prefs.basedIn && (!o.city || sameCity(o.city, city))) ||
      (o.country !== prefs.basedIn && prefs.locations.includes(o.country ?? '')),
  );
  const elsewhere = offices.filter((o) => o.country === prefs.basedIn && o.city);
  if (fine || elsewhere.length === 0) return base;
  const where = elsewhere
    .slice(0, 3)
    .map((o) => o.city)
    .join(', ');
  return part('location', true, OTHER_CITY_VALUE, `Office in ${where} · you're in ${city}`);
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
  if (required.length === 0)
    return workingLanguage(part('language', true, 1, 'no language requirements'), p, prefs);

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
  return workingLanguage(part('language', true, worst.factor, worst.note), p, prefs);
}

/** What a posting in none of the languages the candidate would rather work in is worth. */
export const OTHER_WORKING_LANGUAGE = 0.5;

/**
 * The candidate would rather work in certain languages (a German-speaking team). A posting
 * that names one of them, or is written in one, is fine; one that works only in others counts
 * for less. Nothing known about the posting's languages: left as it is.
 */
function workingLanguage(base: Part, p: PostingExtraction, prefs: Preferences): Part {
  const wanted = prefs.workingLanguages;
  if (wanted.length === 0 || base.value === 0) return base;
  const spoken = new Set(p.languages.map((l) => l.language.toLowerCase()));
  if (p.postingLanguage) spoken.add(p.postingLanguage.toLowerCase());
  if (spoken.size === 0) return base;
  const names = (codes: Iterable<string>) =>
    [...codes].map((c) => LANGUAGE_NAME[c] ?? c).join(', ');
  // Named among the posting's languages it plainly works in; only written in it is a sign of
  // the team's language, worth the same but said as what it is.
  const named = wanted.find((w) => p.languages.some((l) => l.language.toLowerCase() === w));
  const written = wanted.find((w) => p.postingLanguage?.toLowerCase() === w);
  if (named) return { ...base, note: `${base.note} · works in ${LANGUAGE_NAME[named] ?? named}` };
  if (written) {
    return { ...base, note: `${base.note} · written in ${LANGUAGE_NAME[written] ?? written}` };
  }
  return part(
    'language',
    true,
    base.value * OTHER_WORKING_LANGUAGE,
    `${names(spoken)} only · you'd rather work in ${names(wanted)}`,
  );
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
