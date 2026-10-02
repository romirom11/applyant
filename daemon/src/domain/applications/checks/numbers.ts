// Numbers and dates, checked without a model. Exaggerations are mostly about quantities (team
// size, years, scale, money), which is exactly where language models are weakest as judges.
//
//   contradiction  the sentence states a quantity of the same kind as one in its cited facts,
//                  and none of them agrees: "a team of 10" where the fact says "a team of 4".
//                  A hard flag: only the candidate's edit clears it.
//   absent         the sentence states a number no cited fact has: often derived ("5+ years"
//                  from 2019–2024, "$2M" from "€1.8M"). The candidate confirms it in one click,
//                  which makes it a confirmed fact.
//
// "Same kind" is deliberately narrow (team sizes; years, counts, percentages and money only
// when they are about the same noun), so an unrelated number in another fact is never read
// as a contradiction: at worst the sentence's number is "absent".

export type QuantityKind = 'people' | 'years' | 'percent' | 'money' | 'count' | 'year';

export interface Quantity {
  kind: QuantityKind;
  value: number;
  /** What it counts or measures ("call", "latency", "python"); null when unclear. */
  key: string | null;
  /** "5+ years", "over 20k", "at least 3". */
  atLeast: boolean;
  /** For money. */
  currency: string | null;
  /** For year ranges ("2019–2024"): the range's end; `value` is its start. */
  until: number | null;
  raw: string;
}

export type NumberCheck =
  | { kind: 'ok' }
  | { kind: 'contradiction'; sentence: Quantity; fact: Quantity; factId: number }
  | { kind: 'absent'; quantities: Quantity[] };

const WORDS: Record<string, number> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  hundred: 100,
  dozen: 12,
};

const SUFFIX: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mm: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
};

const PEOPLE =
  /^(people|persons?|engineers?|developers?|devs|members?|reports?|staff|employees|folks|teammates|designers?|scientists?|researchers?|contractors?|hires|interns?|colleagues)$/;

const STOP = new Set(
  (
    'a an the of in on at to for by with and or from over more than about around roughly ' +
    'approximately nearly almost up upto some per each every our my their its his her this that ' +
    'these those was were is are be been being has have had which who whom as into across within ' +
    'plus total overall than'
  ).split(' '),
);

const CURRENCY_SIGN: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP' };
const CURRENCY_WORD: Record<string, string> = {
  usd: 'USD',
  dollar: 'USD',
  dollars: 'USD',
  eur: 'EUR',
  euro: 'EUR',
  euros: 'EUR',
  gbp: 'GBP',
  pound: 'GBP',
  pounds: 'GBP',
};

const NUM = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;
const SUF = String.raw`(?:\s?(k|mm|m|bn|b|thousand|million|billion)\b)?`;

function toNumber(digits: string, suffix: string | undefined): number {
  const n = Number(digits.replace(/,/g, ''));
  return n * (suffix ? (SUFFIX[suffix.toLowerCase()] ?? 1) : 1);
}

function singular(word: string): string {
  const w = word.toLowerCase();
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(w)) return w;
  if (w.endsWith('es') && /(ch|sh|x|z)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && w.length > 3) return w.slice(0, -1);
  return w;
}

/** The first content word after `index` (skipping stopwords), singular; null if none soon. */
function nextWord(text: string, index: number): string | null {
  const rest = text.slice(index).match(/[\p{L}][\p{L}\p{N}+#-]*/gu) ?? [];
  for (const w of rest.slice(0, 4)) {
    const lw = w.toLowerCase();
    if (!STOP.has(lw)) return singular(lw);
  }
  return null;
}

/** The last content word before `index` in the same clause (skipping stopwords); null if none. */
function prevWord(text: string, index: number): string | null {
  const clause =
    text
      .slice(Math.max(0, index - 60), index)
      .split(/[,;.:!?()]/)
      .at(-1) ?? '';
  const before = clause.match(/[\p{L}][\p{L}\p{N}+#-]*/gu) ?? [];
  for (const w of before.slice(-4).reverse()) {
    const lw = w.toLowerCase();
    if (!STOP.has(lw)) return singular(lw);
  }
  return null;
}

const AT_LEAST = /(over|more than|at least|above|upwards of|in excess of)\s*$/i;

/** Every quantity a text states: "20k calls", "a team of 4", "5+ years", "40%", "$2M", "2019–2024". */
export function extractQuantities(input: string): Quantity[] {
  // Number words that count something ("four engineers", "team of five"), as digits.
  const text = input.replace(
    /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|dozen)\b/gi,
    (w) => String(WORDS[w.toLowerCase()] ?? w),
  );
  const out: Quantity[] = [];
  const taken: Array<[number, number]> = [];
  const free = (a: number, b: number) => taken.every(([x, y]) => b <= x || a >= y);
  const add = (q: Omit<Quantity, 'raw'>, start: number, end: number) => {
    if (!free(start, end)) return;
    taken.push([start, end]);
    out.push({ ...q, raw: text.slice(start, end) });
  };
  const atLeastBefore = (i: number) => AT_LEAST.test(text.slice(Math.max(0, i - 20), i));

  // Money: $2M · €1.8 million · 50k EUR
  for (const m of text.matchAll(new RegExp(String.raw`([$€£])\s?${NUM}${SUF}`, 'gi'))) {
    const i = m.index ?? 0;
    add(
      {
        kind: 'money',
        value: toNumber(m[2] ?? '0', m[3]),
        key: prevWord(text, i),
        atLeast: atLeastBefore(i),
        currency: CURRENCY_SIGN[m[1] ?? ''] ?? null,
        until: null,
      },
      i,
      i + m[0].length,
    );
  }
  for (const m of text.matchAll(
    new RegExp(String.raw`\b${NUM}${SUF}\s?(usd|eur|gbp|dollars?|euros?|pounds?)\b`, 'gi'),
  )) {
    const i = m.index ?? 0;
    add(
      {
        kind: 'money',
        value: toNumber(m[1] ?? '0', m[2]),
        key: prevWord(text, i),
        atLeast: atLeastBefore(i),
        currency: CURRENCY_WORD[(m[3] ?? '').toLowerCase()] ?? null,
        until: null,
      },
      i,
      i + m[0].length,
    );
  }
  // Percentages: 40% · 40 percent
  for (const m of text.matchAll(new RegExp(String.raw`\b${NUM}\s?(%|percent\b)`, 'gi'))) {
    const i = m.index ?? 0;
    add(
      {
        kind: 'percent',
        value: toNumber(m[1] ?? '0', undefined),
        key: prevWord(text, i) ?? nextWord(text, i + m[0].length),
        atLeast: atLeastBefore(i),
        currency: null,
        until: null,
      },
      i,
      i + m[0].length,
    );
  }
  // Year ranges: 2019–2024 · 2021-present
  for (const m of text.matchAll(
    /\b((?:19|20)\d{2})\s?(?:–|—|-|to|until)\s?((?:19|20)\d{2}|present|now|today)\b/gi,
  )) {
    const i = m.index ?? 0;
    const end = /^\d/.test(m[2] ?? '') ? Number(m[2]) : new Date().getUTCFullYear();
    add(
      {
        kind: 'year',
        value: Number(m[1]),
        key: null,
        atLeast: false,
        currency: null,
        until: end,
      },
      i,
      i + m[0].length,
    );
  }
  // Durations in years: 5+ years · 5 years of Python · over 3 years
  for (const m of text.matchAll(
    new RegExp(String.raw`\b${NUM}\s?(\+)?\s?(?:-\s?)?years?\b`, 'gi'),
  )) {
    const i = m.index ?? 0;
    const after = text.slice(i + m[0].length);
    const of = /^\s*(?:of|in|with|as|at|building|writing|running|working)\b/i.test(after);
    add(
      {
        kind: 'years',
        value: toNumber(m[1] ?? '0', undefined),
        key: of ? nextWord(text, i + m[0].length) : null,
        atLeast: !!m[2] || atLeastBefore(i),
        currency: null,
        until: null,
      },
      i,
      i + m[0].length,
    );
  }
  // Team sizes: a team of 4 · 4-person team · 10 engineers
  for (const m of text.matchAll(
    new RegExp(String.raw`\bteam of (?:about |around |up to )?${NUM}`, 'gi'),
  )) {
    const i = m.index ?? 0;
    add(
      {
        kind: 'people',
        value: toNumber(m[1] ?? '0', undefined),
        key: 'team',
        atLeast: atLeastBefore(i),
        currency: null,
        until: null,
      },
      i,
      i + m[0].length,
    );
  }
  for (const m of text.matchAll(
    new RegExp(
      String.raw`\b${NUM}(\+)?[\s-](?:person|people|member|strong|engineer)[\s-]team\b`,
      'gi',
    ),
  )) {
    const i = m.index ?? 0;
    add(
      {
        kind: 'people',
        value: toNumber(m[1] ?? '0', undefined),
        key: 'team',
        atLeast: !!m[2] || atLeastBefore(i),
        currency: null,
        until: null,
      },
      i,
      i + m[0].length,
    );
  }
  // Counts: 20k calls · 3 services · 12 engineers (people) · 2023 (a year)
  for (const m of text.matchAll(new RegExp(String.raw`\b${NUM}${SUF}(\+)?`, 'gi'))) {
    const i = m.index ?? 0;
    const end = i + m[0].length;
    if (!free(i, end)) continue;
    const digits = m[1] ?? '0';
    // Part of a version, time or identifier ("v2.1", "3:30", "#12", "PR-42").
    const before = text.slice(Math.max(0, i - 1), i);
    const afterCh = text.slice(end, end + 1);
    if (/[.:#/\w-]/.test(before) || /[.:/]\d/.test(text.slice(end, end + 2)) || afterCh === '%') {
      continue;
    }
    // A bare decimal is a version ("Python 3.12"), not a count.
    if (!m[2] && digits.includes('.')) continue;
    const value = toNumber(digits, m[2]);
    const yearish =
      /\b(in|since|from|until|till|by|during|of|early|late|mid|year|circa|around)\s*$/i.test(
        text.slice(Math.max(0, i - 12), i),
      ) || /^\s*($|[.,;:)–—-])/.test(text.slice(end));
    if (!m[2] && /^(19|20)\d{2}$/.test(digits) && yearish) {
      add({ kind: 'year', value, key: null, atLeast: false, currency: null, until: null }, i, end);
      continue;
    }
    const noun = nextWord(text, end);
    add(
      {
        kind: noun && PEOPLE.test(noun) ? 'people' : 'count',
        value,
        key: noun && PEOPLE.test(noun) ? 'team' : noun,
        atLeast: !!m[3] || atLeastBefore(i),
        currency: null,
        until: null,
      },
      i,
      end,
    );
  }
  return out;
}

function approx(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 0.005);
}

/** Same kind of thing, so different values would contradict each other. */
export function sameDimension(a: Quantity, b: Quantity): boolean {
  if (a.kind !== b.kind || a.kind === 'year') return false;
  if (a.kind === 'people') return true;
  if (a.kind === 'money' && a.currency && b.currency && a.currency !== b.currency) return false;
  return a.key !== null && a.key === b.key;
}

/** The fact's quantity backs the sentence's ("5+ years" is backed by "6 years"). */
export function sameQuantity(said: Quantity, fact: Quantity): boolean {
  if (said.kind === 'year' || fact.kind === 'year') {
    const lo = fact.value;
    const hi = fact.until ?? fact.value;
    if (said.kind === 'year' && said.until === null) return said.value >= lo && said.value <= hi;
    if (said.kind === 'year' && fact.kind === 'year') {
      return said.value >= lo && (said.until ?? said.value) <= hi;
    }
    return false;
  }
  if (said.kind === 'money' && fact.kind === 'money') {
    if (said.currency && fact.currency && said.currency !== fact.currency) return false;
  }
  if (approx(said.value, fact.value)) return true;
  return said.atLeast && fact.value >= said.value;
}

/** The fact only says "at least", so a larger number in the sentence isn't a contradiction. */
function openEnded(said: Quantity, fact: Quantity): boolean {
  return fact.atLeast && said.value >= fact.value;
}

export interface CheckFact {
  id: number;
  text: string;
  /** The project's period ("2019–2024"): dates in a sentence may come from it. */
  period?: string | null;
  /**
   * The project the fact belongs to and the candidate's role there ("Tech Lead at NDA · role:
   * Tech Lead"): a sentence may say "as Tech Lead" from it.
   */
  project?: string | null;
}

/**
 * Checks one sentence against the facts it cites. `extra` holds texts whose numbers the
 * sentence may use without a fact (the candidate's own profile values for this application).
 */
export function checkNumbers(
  sentence: string,
  facts: CheckFact[],
  extra: string[] = [],
  /**
   * Texts about the employer (the posting): their counts, money and percentages may be
   * repeated ("while you grow past 270 merchants"), never their years or team sizes, which
   * would read as the candidate's.
   */
  about: string[] = [],
): NumberCheck {
  const said = extractQuantities(sentence);
  if (said.length === 0) return { kind: 'ok' };
  const known = facts.flatMap((f) =>
    [f.text, f.period ?? ''].flatMap((t) => extractQuantities(t).map((q) => ({ q, id: f.id }))),
  );
  const allowed = extra.flatMap((t) => extractQuantities(t));
  const employer = about.flatMap((t) => extractQuantities(t));
  const absent: Quantity[] = [];
  for (const q of said) {
    const same = known.filter((k) => sameDimension(q, k.q));
    if (same.some((k) => sameQuantity(q, k.q))) continue;
    const conflict = same.find((k) => !openEnded(q, k.q));
    if (conflict && !same.some((k) => openEnded(q, k.q))) {
      return { kind: 'contradiction', sentence: q, fact: conflict.q, factId: conflict.id };
    }
    if (
      known.some((k) => sameQuantity(q, k.q) || (k.q.kind === q.kind && approx(q.value, k.q.value)))
    ) {
      continue;
    }
    if (allowed.some((a) => approx(q.value, a.value))) continue;
    if (
      q.kind !== 'years' &&
      q.kind !== 'people' &&
      employer.some((a) => a.kind === q.kind && approx(q.value, a.value))
    ) {
      continue;
    }
    absent.push(q);
  }
  return absent.length ? { kind: 'absent', quantities: absent } : { kind: 'ok' };
}

/** Human text for review: `fact #7 says "team of 4"; the sentence says "team of 10"`, or the absent numbers. */
export function describeCheck(c: NumberCheck): string | null {
  switch (c.kind) {
    case 'ok':
      return null;
    case 'contradiction':
      return `fact #${c.factId} says "${c.fact.raw}"; the sentence says "${c.sentence.raw}"`;
    case 'absent':
      return c.quantities.map((q) => `"${q.raw}"`).join(', ');
  }
}
