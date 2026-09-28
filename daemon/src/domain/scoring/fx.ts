// Reference exchange rates for comparing salaries: the ECB's daily euro rates, cached in
// fx_rates and refreshed at most once a day. score() takes the cached rates as input, so it
// stays pure; a currency without a rate makes the salary "uncertain", never wrong.
import type { Conn } from '../../db/client.ts';
import { fxRates } from '../../db/schema.ts';

export interface FxRates {
  /** The rates' own date. */
  asOf: string;
  /** Units of each currency per 1 EUR (EUR itself is 1). */
  perEur: Record<string, number>;
}

export interface FxSource {
  fetch(signal: AbortSignal): Promise<FxRates>;
}

export const FX_MAX_AGE_MS = 24 * 3_600_000;

const ECB_DAILY = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

export function parseEcbXml(xml: string): FxRates {
  const asOf = /time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  const perEur: Record<string, number> = { EUR: 1 };
  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) {
    const rate = Number(m[2]);
    if (m[1] && Number.isFinite(rate) && rate > 0) perEur[m[1]] = rate;
  }
  if (!asOf || Object.keys(perEur).length < 2) throw new Error('unexpected ECB rates document');
  return { asOf, perEur };
}

export class EcbFx implements FxSource {
  async fetch(signal: AbortSignal): Promise<FxRates> {
    const res = await fetch(ECB_DAILY, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!res.ok) throw new Error(`ECB rates: HTTP ${res.status}`);
    return parseEcbXml(await res.text());
  }
}

export function convert(
  amount: number,
  from: string,
  to: string,
  rates: FxRates | null,
): number | null {
  if (from === to) return amount;
  const a = from === 'EUR' ? 1 : rates?.perEur[from];
  const b = to === 'EUR' ? 1 : rates?.perEur[to];
  if (!a || !b) return null;
  return (amount / a) * b;
}

export function loadRates(conn: Conn): (FxRates & { fetchedAt: Date }) | null {
  const rows = conn.select().from(fxRates).all();
  if (rows.length === 0) return null;
  const perEur: Record<string, number> = { EUR: 1 };
  let fetchedAt = rows[0]?.fetchedAt ?? new Date(0);
  let asOf = rows[0]?.asOf ?? '';
  for (const r of rows) {
    perEur[r.currency] = r.perEur;
    if (r.fetchedAt < fetchedAt) fetchedAt = r.fetchedAt;
    if (r.asOf > asOf) asOf = r.asOf;
  }
  return { asOf, perEur, fetchedAt };
}

export function saveRates(conn: Conn, rates: FxRates, now: Date): void {
  for (const [currency, perEur] of Object.entries(rates.perEur)) {
    if (currency === 'EUR') continue;
    conn
      .insert(fxRates)
      .values({ currency, perEur, asOf: rates.asOf, fetchedAt: now })
      .onConflictDoUpdate({
        target: fxRates.currency,
        set: { perEur, asOf: rates.asOf, fetchedAt: now },
      })
      .run();
  }
}

/**
 * Whether comparing these currencies needs a (re)fetch: rates are missing or older than a
 * day. A currency the ECB doesn't publish stays uncertain until the next daily refresh.
 */
export function needsRates(
  rates: (FxRates & { fetchedAt: Date }) | null,
  currencies: string[],
  now: Date,
): boolean {
  if (new Set(currencies).size < 2) return false;
  return !rates || now.getTime() - rates.fetchedAt.getTime() > FX_MAX_AGE_MS;
}
