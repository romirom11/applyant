// Structured posting data over the extractor's reading of the page. Where the page states a
// field in structured form, that wins; the extractor fills the rest. Deterministic, applied
// after every extraction.
//
// The page's own workplace label (a separate "Hybrid" / "Remote" / "On-site" element in the
// header, next to the title and location) decides the workplace first: it is how the board
// classifies the role, and body text (a remote-work perk) can't override it.
//
// Then, from the JobPosting JSON-LD:
//   employmentType              → employment
//   baseSalary (with numbers)   → salary (gross: a base salary is gross by convention)
//   jobLocation addresses       → offices (first), with the extractor's other offices after
//   applicantLocationRequirements → remoteCountries, when the role is at least partly remote
//   jobLocationType TELECOMMUTE → remote only when no office is given. Boards also mark hybrid
//                                 roles TELECOMMUTE (Workable does), so with an office address
//                                 it only rules out "onsite"; the page's own label decides.
import type {
  EmploymentType,
  PostingExtraction,
  SalaryPeriod,
  Workplace,
} from '../../models/schemas/posting.ts';
import { PAGE_HEADER_PREFIX } from '../search/posting-text.ts';

type Node = Record<string, unknown>;

export interface StructuredPosting {
  /** The workplace label in the page header, if the page shows one. */
  pageWorkplace: Workplace | null;
  telecommute: boolean;
  offices: Array<{ city: string | null; country: string | null }>;
  applicantCountries: string[];
  employment: EmploymentType | null;
  salary: PostingExtraction['salary'];
}

const NOT_COUNTRIES = new Set('AA AN BU CS DD EU EZ FX NT SU TP UK UN YD YU ZR ZZ'.split(' '));
let countryNames: Map<string, string> | null = null;

/** ISO 3166-1 alpha-2 for a code or an English country name ("Greece", "United Kingdom"). */
export function countryCode(value: unknown): string | null {
  const raw =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && typeof (value as Node).name === 'string'
        ? ((value as Node).name as string)
        : null;
  if (!raw) return null;
  const v = raw.trim();
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase() === 'UK' ? 'GB' : v.toUpperCase();
  if (!countryNames) {
    countryNames = new Map([
      ['usa', 'US'],
      ['united states of america', 'US'],
      ['uk', 'GB'],
      ['england', 'GB'],
      ['czech republic', 'CZ'],
      ['bosnia', 'BA'],
    ]);
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    for (let a = 65; a <= 90; a++) {
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        const name = names.of(code);
        // ICU also names deprecated and non-country codes (DD, CS, UK, EU, …): skip them.
        if (NOT_COUNTRIES.has(code) || /^(Q|X[^K])/.test(code)) continue;
        if (name && name !== code && !countryNames.has(name.toLowerCase())) {
          countryNames.set(name.toLowerCase(), code);
        }
      }
    }
  }
  return countryNames.get(v.toLowerCase()) ?? null;
}

const asArray = (v: unknown): unknown[] =>
  Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];

const EMPLOYMENT: Record<string, EmploymentType> = {
  full_time: 'full_time',
  fulltime: 'full_time',
  part_time: 'part_time',
  parttime: 'part_time',
  contractor: 'contract',
  contract: 'contract',
  temporary: 'temporary',
  intern: 'internship',
  internship: 'internship',
  per_diem: 'temporary',
};

const UNIT: Record<string, SalaryPeriod> = {
  HOUR: 'hour',
  DAY: 'day',
  MONTH: 'month',
  YEAR: 'year',
};

function salaryFrom(base: unknown): PostingExtraction['salary'] {
  if (!base || typeof base !== 'object') return null;
  const b = base as Node;
  const currency = typeof b.currency === 'string' ? b.currency.toUpperCase() : null;
  const value = (b.value ?? null) as Node | number | null;
  const num = (x: unknown) =>
    typeof x === 'number' ? x : typeof x === 'string' ? Number(x) : Number.NaN;
  let min: number | null = null;
  let max: number | null = null;
  let unit: unknown = null;
  if (typeof value === 'number' || typeof value === 'string') {
    min = max = num(value);
  } else if (value && typeof value === 'object') {
    const v = num(value.value);
    min = Number.isFinite(num(value.minValue))
      ? num(value.minValue)
      : Number.isFinite(v)
        ? v
        : null;
    max = Number.isFinite(num(value.maxValue))
      ? num(value.maxValue)
      : Number.isFinite(v)
        ? v
        : null;
    unit = value.unitText;
  }
  unit ??= b.unitText;
  const period = typeof unit === 'string' ? (UNIT[unit.toUpperCase()] ?? null) : null;
  if (!currency || !period || !(min && min > 0) || !(max && max > 0)) return null;
  return {
    min,
    max,
    currency,
    period,
    basis: 'gross',
    text: `${min === max ? min : `${min}–${max}`} ${currency} per ${period} (structured data)`,
  };
}

const LABEL: Array<[RegExp, Workplace]> = [
  [/^(fully |100% )?remote( first| friendly)?( \(.*\))?$/i, 'remote'],
  [/^hybrid( \(.*\)| remote)?$/i, 'hybrid'],
  [/^(on-?site|on site|in-office|in office|office-based|office based)( \(.*\))?$/i, 'onsite'],
];

/**
 * The workplace label among the page header's pieces (see posting-text.ts): a piece that is
 * only the label, as boards render it (Workable "Hybrid", Ashby "Remote", Lever "On-site").
 */
export function pageWorkplace(text: string | null): Workplace | null {
  const line = text?.split('\n').find((l) => l.startsWith(PAGE_HEADER_PREFIX));
  if (!line) return null;
  for (const piece of line.slice(PAGE_HEADER_PREFIX.length).split(' | ')) {
    const p = piece.trim();
    if (p.length > 30) continue;
    const hit = LABEL.find(([re]) => re.test(p));
    if (hit) return hit[1];
  }
  return null;
}

/** Page label + JSON-LD, or null when the page has neither. */
export function structuredFromPage(
  node: Node | null,
  text: string | null,
): StructuredPosting | null {
  const label = pageWorkplace(text);
  const fromLd = structuredFromJsonLd(node);
  if (!fromLd && !label) return null;
  return {
    ...(fromLd ?? {
      telecommute: false,
      offices: [],
      applicantCountries: [],
      employment: null,
      salary: null,
    }),
    pageWorkplace: label,
  };
}

export function structuredFromJsonLd(node: Node | null): StructuredPosting | null {
  if (!node) return null;
  const offices = asArray(node.jobLocation)
    .map((place) => {
      const address = (place as Node | null)?.address as Node | string | undefined;
      if (!address) return null;
      if (typeof address === 'string') return { city: address, country: null };
      const city =
        typeof address.addressLocality === 'string' ? address.addressLocality.trim() : null;
      return { city: city || null, country: countryCode(address.addressCountry) };
    })
    .filter(
      (o): o is { city: string | null; country: string | null } => !!o && (!!o.city || !!o.country),
    );
  const employment =
    asArray(node.employmentType)
      .map((e) =>
        typeof e === 'string' ? EMPLOYMENT[e.toLowerCase().replace(/[-\s]/g, '_')] : undefined,
      )
      .find((e) => e !== undefined) ?? null;
  return {
    pageWorkplace: null,
    telecommute: asArray(node.jobLocationType).some(
      (t) => String(t).toUpperCase() === 'TELECOMMUTE',
    ),
    offices,
    applicantCountries: [
      ...new Set(
        asArray(node.applicantLocationRequirements)
          .map(countryCode)
          .filter((c): c is string => !!c),
      ),
    ],
    employment,
    salary: salaryFrom(node.baseSalary),
  };
}

/**
 * What scoring uses: the stored extraction with the page's structured data applied. Pure, so
 * re-scoring after a change to these rules needs no model call.
 */
export function effectiveExtraction(row: {
  extraction: PostingExtraction | null;
  jsonLd: Record<string, unknown> | null;
  text: string | null;
}): { extraction: PostingExtraction; decided: string[] } | null {
  if (!row.extraction) return null;
  return applyStructured(row.extraction, structuredFromPage(row.jsonLd, row.text));
}

/** The extraction with structured fields applied, and which fields they decided. */
export function applyStructured(
  ex: PostingExtraction,
  st: StructuredPosting | null,
): { extraction: PostingExtraction; decided: string[] } {
  if (!st) return { extraction: ex, decided: [] };
  const out: PostingExtraction = { ...ex };
  const decided: string[] = [];
  if (st.employment) {
    out.employment = st.employment;
    decided.push('employment');
  }
  if (st.salary) {
    out.salary = {
      ...st.salary,
      basis: ex.salary?.basis === 'net' ? 'net' : 'gross',
      text: ex.salary?.text || st.salary.text,
    };
    decided.push('salary');
  }
  if (st.offices.length) {
    const known = new Set(
      st.offices.map((o) => `${o.city ?? ''}|${o.country ?? ''}`.toLowerCase()),
    );
    const countries = new Set(st.offices.map((o) => o.country));
    const others = ex.offices.filter(
      (o) =>
        !known.has(`${o.city ?? ''}|${o.country ?? ''}`.toLowerCase()) &&
        !(o.city === null && countries.has(o.country)),
    );
    out.offices = [...st.offices, ...others];
    decided.push('offices');
  }
  if (st.pageWorkplace) {
    out.workplace = st.pageWorkplace;
    decided.push('workplace (page label)');
  } else if (st.telecommute && st.offices.length === 0) {
    out.workplace = 'remote';
    decided.push('workplace');
  } else if (st.telecommute && ex.workplace === 'onsite') {
    out.workplace = 'hybrid';
    decided.push('workplace');
  }
  if (st.telecommute) {
    if (st.applicantCountries.length && out.workplace !== 'onsite') {
      // The stated countries are the remote scope, over regions read from body text.
      out.remoteCountries = st.applicantCountries;
      out.remoteRegions = [];
      decided.push('remote countries');
    }
  }
  return { extraction: out, decided };
}
