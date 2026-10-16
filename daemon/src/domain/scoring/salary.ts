// Salaries are compared in the candidate's target unit (e.g. monthly gross EUR). Whatever
// can't be compared honestly (no period, gross/net unknown, no exchange rate) is
// "uncertain": shown, never penalised, so "17% below target" appears only when it's true.
//
// Boards like Djinni show bare "$1500–2500" (no "per month", no "gross"). Those are
// monthly gross in practice — normaliseExtraction also fills the gap — but as a final
// guard normalisation here infers month/gross for any bare dollar range so a missing
// qualifier never hides a salary from scoring.
import type { PostingExtraction, SalaryPeriod } from '../../models/schemas/posting.ts';
import { convert, type FxRates } from './fx.ts';

export type TargetPeriod = 'month' | 'year';

export interface Money {
  amount: number;
  currency: string;
  period: TargetPeriod;
}

export type NormalisedSalary =
  | {
      kind: 'comparable';
      min: number | null;
      max: number | null;
      /** What the posting offers at best: the top of the range, or its only figure. */
      offered: number;
      currency: string;
      period: TargetPeriod;
      /** Set when the posting's own unit differs: "$90,000/year". */
      original: string | null;
    }
  | { kind: 'uncertain'; reason: string };

/** Full-time equivalents: 40 h/week, 5 days/week, 52 weeks. */
const PER_MONTH: Record<SalaryPeriod, number> = {
  hour: (40 * 52) / 12,
  day: (5 * 52) / 12,
  month: 1,
  year: 1 / 12,
};

export function perPeriod(amount: number, from: SalaryPeriod, to: TargetPeriod): number {
  const monthly = amount * PER_MONTH[from];
  return to === 'month' ? monthly : monthly * 12;
}

function inferBareMonthly(s: NonNullable<PostingExtraction['salary']>): SalaryPeriod | null {
  const t = (s.text ?? '').toLowerCase();
  // Don't guess when period is explicitly stated in other units (e.g. "$30/hour", "$400/day", "per year").
  if (/\b(per\s+)?(hour|day|week|year|annum|pa)\b/.test(t) || /\/\s*(hour|day|year|yr|week|mo)\b/.test(t)) return null;
  const looksDollar = /\$/.test(t);
  const bareRange =
    /\bto\s*\$\s*\d/i.test(t) ||
    /\$\s*\d[\d,]*\s*[-–—]\s*\$?\s*\d/.test(t) ||
    /\b\d[\d,]*\s*[-–—]\s*\$\s*\d/.test(t);
  if (bareRange) return 'month';
  // Lone "$3000" on boards like Djinni is monthly; "$90,000" yearly is usually written with "per year".
  if (looksDollar && /\$\s*\d[\d,]*/.test(t)) return 'month';
  return null;
}

export function normaliseSalary(
  s: PostingExtraction['salary'],
  unit: { currency: string; period: TargetPeriod },
  fx: FxRates | null,
): NormalisedSalary {
  if (!s || (s.min === null && s.max === null)) {
    return { kind: 'uncertain', reason: 'no salary stated' };
  }
  if (!s.currency) return { kind: 'uncertain', reason: `currency not stated (${s.text})` };
  const period: SalaryPeriod | null = s.period ?? inferBareMonthly(s);
  const basis = s.basis ?? (inferBareMonthly(s) ? 'gross' : null);
  if (!period) return { kind: 'uncertain', reason: `period not stated (${s.text})` };
  if (!basis) return { kind: 'uncertain', reason: `gross or net not stated (${s.text})` };
  if (basis === 'net') {
    return { kind: 'uncertain', reason: `net salary, your target is gross (${s.text})` };
  }
  const effectivePeriod: SalaryPeriod = (period as SalaryPeriod) ?? (s.period as SalaryPeriod);
  const to = (n: number | null): number | null | undefined => {
    if (n === null) return null;
    const c = convert(
      perPeriod(n, effectivePeriod, unit.period),
      s.currency as string,
      unit.currency,
      fx,
    );
    return c === null ? undefined : c;
  };
  const min = to(s.min);
  const max = to(s.max);
  if (min === undefined || max === undefined) {
    return { kind: 'uncertain', reason: `no exchange rate for ${s.currency} (${s.text})` };
  }
  const offered = max ?? min;
  if (offered === null || offered <= 0) return { kind: 'uncertain', reason: 'no salary stated' };
  const same = s.currency === unit.currency && period === unit.period;
  return {
    kind: 'comparable',
    min,
    max,
    offered,
    currency: unit.currency,
    period: unit.period,
    original: same ? null : formatMoney(s.max ?? s.min ?? 0, s.currency, period as SalaryPeriod),
  };
}

const SYMBOL: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' };

/** "€2,000–2,500/month". */
export function formatRange(
  min: number,
  max: number,
  currency: string,
  period: SalaryPeriod,
): string {
  return `${formatMoney(min, currency)}–${Math.round(max).toLocaleString('en-US')}/${period}`;
}

/** "€2,500/month", "CHF 7,000/month", "$90,000/year". */
export function formatMoney(amount: number, currency: string, period?: SalaryPeriod): string {
  const n = Math.round(amount).toLocaleString('en-US');
  const symbol = SYMBOL[currency];
  const value = symbol ? `${symbol}${n}` : `${currency} ${n}`;
  return period ? `${value}/${period}` : value;
}
