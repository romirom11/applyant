// Salaries are compared in the candidate's target unit (e.g. monthly gross EUR). Whatever
// can't be compared honestly (no period, gross/net unknown, no exchange rate) is
// "uncertain": shown, never penalised, so "17% below target" appears only when it's true.
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

export function normaliseSalary(
  s: PostingExtraction['salary'],
  unit: { currency: string; period: TargetPeriod },
  fx: FxRates | null,
): NormalisedSalary {
  if (!s || (s.min === null && s.max === null)) {
    return { kind: 'uncertain', reason: 'no salary stated' };
  }
  if (!s.currency) return { kind: 'uncertain', reason: `currency not stated (${s.text})` };
  if (!s.period) return { kind: 'uncertain', reason: `period not stated (${s.text})` };
  if (!s.basis) return { kind: 'uncertain', reason: `gross or net not stated (${s.text})` };
  if (s.basis === 'net') {
    return { kind: 'uncertain', reason: `net salary, your target is gross (${s.text})` };
  }
  const to = (n: number | null): number | null | undefined => {
    if (n === null) return null;
    const c = convert(
      perPeriod(n, s.period as SalaryPeriod, unit.period),
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
  const same = s.currency === unit.currency && s.period === unit.period;
  return {
    kind: 'comparable',
    min,
    max,
    offered,
    currency: unit.currency,
    period: unit.period,
    original: same ? null : formatMoney(s.max ?? s.min ?? 0, s.currency, s.period),
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
