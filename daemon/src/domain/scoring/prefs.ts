// Search and scoring preferences: what the candidate wants (roles, where, how, how much),
// their dealbreakers, the component weights and the auto-prepare threshold. Stored per key
// in `preferences`; every change re-runs the pure score() over cached extractions.
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Conn } from '../../db/client.ts';
import { preferences } from '../../db/schema.ts';
import {
  EMPLOYMENT_TYPES,
  type EmploymentType,
  ROLE_FAMILIES,
  type RoleFamily,
  SENIORITIES,
  type Seniority,
} from '../../models/schemas/posting.ts';
import type { Money } from './salary.ts';
import { COMPONENT_KEYS, type ComponentKey, type Weights } from './types.ts';

export const REMOTE_PREFS = ['required', 'preferred', 'any'] as const;
export type RemotePref = (typeof REMOTE_PREFS)[number];

export const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'native'] as const;
export type CefrLevel = (typeof CEFR_LEVELS)[number];

/** Conditions the candidate can make hard. Nothing is a dealbreaker unless they say so. */
export const DEALBREAKERS = [
  'outstaffing',
  'onsite',
  'location',
  'language',
  'employment',
  'seniority',
] as const;
export type Dealbreaker = (typeof DEALBREAKERS)[number];

export interface Preferences {
  /** Kinds of role wanted; empty = any. */
  roles: RoleFamily[];
  /** Seniority levels wanted; empty = any. */
  seniority: Seniority[];
  /** ISO country code where the candidate lives and works from. */
  basedIn: string | null;
  /** Countries where on-site or hybrid work is fine (besides `basedIn`). */
  locations: string[];
  remote: RemotePref;
  /** The target salary (gross). Feeds the score in proportion to how far off a posting is. */
  salary: Money | null;
  /** An optional hard floor: a comparable salary below it is a dealbreaker. */
  salaryFloor: Money | null;
  /** Languages the candidate speaks, ISO 639-1 → level. */
  languages: Record<string, CefrLevel>;
  /** Employment types accepted; empty = any. */
  employment: EmploymentType[];
  dealbreakers: Dealbreaker[];
  /** Base component weights, before bounded feedback. */
  weights: Weights;
  /** Auto-prepare at or above this score (used from phase 5). */
  threshold: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  must: 35,
  nice: 10,
  role: 15,
  location: 10,
  remote: 10,
  salary: 10,
  language: 5,
  employment: 5,
};

export const DEFAULT_PREFERENCES: Preferences = {
  roles: [],
  seniority: [],
  basedIn: null,
  locations: [],
  remote: 'any',
  salary: null,
  salaryFloor: null,
  languages: {},
  employment: [],
  dealbreakers: [],
  weights: DEFAULT_WEIGHTS,
  threshold: 80,
};

export class PreferenceError extends Error {}

const country = z.string().regex(/^[A-Z]{2}$/);
const money = z.object({
  amount: z.number().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  period: z.enum(['month', 'year']),
});

/** Stored key → (field, validator). */
const FIELDS = {
  roles: { field: 'roles', schema: z.array(z.enum(ROLE_FAMILIES)) },
  seniority: { field: 'seniority', schema: z.array(z.enum(SENIORITIES)) },
  based_in: { field: 'basedIn', schema: country.nullable() },
  locations: { field: 'locations', schema: z.array(country) },
  remote: { field: 'remote', schema: z.enum(REMOTE_PREFS) },
  salary: { field: 'salary', schema: money.nullable() },
  salary_floor: { field: 'salaryFloor', schema: money.nullable() },
  languages: {
    field: 'languages',
    schema: z.record(z.string().regex(/^[a-z]{2}$/), z.enum(CEFR_LEVELS)),
  },
  employment: { field: 'employment', schema: z.array(z.enum(EMPLOYMENT_TYPES)) },
  dealbreakers: { field: 'dealbreakers', schema: z.array(z.enum(DEALBREAKERS)) },
  weights: {
    field: 'weights',
    schema: z.record(z.enum(COMPONENT_KEYS), z.number().min(0).max(100)),
  },
  threshold: { field: 'threshold', schema: z.number().int().min(0).max(100) },
} as const satisfies Record<string, { field: keyof Preferences; schema: z.ZodType }>;

export type PreferenceKey = keyof typeof FIELDS;
export const PREFERENCE_KEYS = Object.keys(FIELDS) as PreferenceKey[];

export function getPreferences(conn: Conn): Preferences {
  const prefs: Preferences = { ...DEFAULT_PREFERENCES, weights: { ...DEFAULT_WEIGHTS } };
  for (const row of conn.select().from(preferences).all()) {
    const spec = FIELDS[row.key as PreferenceKey];
    if (!spec) continue;
    const parsed = spec.schema.safeParse(row.value);
    if (!parsed.success) continue;
    if (row.key === 'weights') {
      prefs.weights = { ...DEFAULT_WEIGHTS, ...(parsed.data as Partial<Weights>) };
    } else {
      (prefs as unknown as Record<string, unknown>)[spec.field] = parsed.data;
    }
  }
  return prefs;
}

/** Stores one key; `null` resets it to the default. */
export function setPreference(conn: Conn, key: PreferenceKey, value: unknown, now: Date): void {
  if (value === null || value === undefined) {
    conn.delete(preferences).where(eq(preferences.key, key)).run();
    return;
  }
  const parsed = FIELDS[key].schema.safeParse(value);
  if (!parsed.success) throw new PreferenceError(`invalid value for ${key}`);
  conn
    .insert(preferences)
    .values({ key, value: parsed.data, updatedAt: now })
    .onConflictDoUpdate({ target: preferences.key, set: { value: parsed.data, updatedAt: now } })
    .run();
}

function list(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

function oneOf<T extends string>(values: readonly T[], raw: string, what: string): T {
  const v = raw.trim().toLowerCase().replace(/-/g, '_') as T;
  if (!values.includes(v)) {
    throw new PreferenceError(`unknown ${what} "${raw}" (one of: ${values.join(', ')})`);
  }
  return v;
}

function countries(raw: string): string[] {
  return list(raw).map((c) => {
    const code = c.toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) {
      throw new PreferenceError(`"${c}" is not a two-letter country code (e.g. GR, CY, DE)`);
    }
    return code;
  });
}

const CURRENCY_SYMBOLS: Record<string, string> = { '€': 'EUR', $: 'USD', '£': 'GBP' };

/** "3000 EUR/month", "€3,000 per month", "60k EUR a year". */
export function parseMoney(raw: string): Money {
  const text = raw.trim();
  const amountMatch = /(\d[\d,. ]*)(k)?/i.exec(text);
  if (!amountMatch?.[1]) throw new PreferenceError(`no amount in "${raw}"`);
  let amount = Number(amountMatch[1].replace(/[, ]/g, ''));
  if (amountMatch[2]) amount *= 1000;
  if (!Number.isFinite(amount) || amount <= 0) throw new PreferenceError(`bad amount in "${raw}"`);
  const symbol = Object.keys(CURRENCY_SYMBOLS).find((s) => text.includes(s));
  const code = /\b([A-Za-z]{3})\b/.exec(
    text.replace(/\b(per|a|an|year|yr|month|mth|mo|yearly|monthly|annual|annum|pa)\b/gi, ''),
  );
  const currency = symbol ? CURRENCY_SYMBOLS[symbol] : code?.[1]?.toUpperCase();
  if (!currency) throw new PreferenceError(`no currency in "${raw}" (e.g. "3000 EUR/month")`);
  const period = /\b(month|mo|monthly|mth)\b/i.test(text)
    ? 'month'
    : /\b(year|yr|yearly|annual|annually|annum|pa)\b/i.test(text)
      ? 'year'
      : null;
  if (!period) throw new PreferenceError(`say per month or per year: "${raw}"`);
  return { amount, currency, period };
}

export interface ParsedPreference {
  key: PreferenceKey;
  /** null resets the key to its default. */
  value: unknown;
}

/**
 * Parses a CLI value. Lists are comma- or space-separated; an empty value resets the key.
 * `weight.<component> <0–100>` changes one weight, `weights reset` all of them.
 */
export function parsePreference(key: string, raw: string, current: Preferences): ParsedPreference {
  const value = raw.trim();
  const weight = /^weights?\.(\w+)$/.exec(key);
  if (weight) {
    const component = oneOf(COMPONENT_KEYS, weight[1] ?? '', 'score component') as ComponentKey;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      throw new PreferenceError('a weight is a number from 0 to 100');
    }
    return { key: 'weights', value: { ...current.weights, [component]: n } };
  }
  if (!(PREFERENCE_KEYS as string[]).includes(key)) {
    throw new PreferenceError(
      `unknown preference "${key}" (known: ${PREFERENCE_KEYS.join(', ')}, weight.<component>)`,
    );
  }
  const k = key as PreferenceKey;
  if (value === '' || (k === 'weights' && value === 'reset')) return { key: k, value: null };
  switch (k) {
    case 'roles':
      return { key: k, value: list(value).map((v) => oneOf(ROLE_FAMILIES, v, 'role family')) };
    case 'seniority':
      return { key: k, value: list(value).map((v) => oneOf(SENIORITIES, v, 'seniority')) };
    case 'based_in': {
      const [code, ...rest] = countries(value);
      if (rest.length) throw new PreferenceError('based_in is one country');
      return { key: k, value: code };
    }
    case 'locations':
      return { key: k, value: countries(value) };
    case 'remote':
      return { key: k, value: oneOf(REMOTE_PREFS, value, 'remote preference') };
    case 'salary':
    case 'salary_floor':
      return { key: k, value: parseMoney(value) };
    case 'languages': {
      const out: Record<string, CefrLevel> = {};
      for (const item of list(value)) {
        const [lang, level] = item.split(':');
        if (!lang || !/^[a-z]{2}$/i.test(lang) || !level) {
          throw new PreferenceError(`"${item}" is not language:level (e.g. en:C1, el:native)`);
        }
        const l = level === 'native' ? 'native' : level.toUpperCase();
        if (!(CEFR_LEVELS as readonly string[]).includes(l)) {
          throw new PreferenceError(`unknown level "${level}" (A1–C2 or native)`);
        }
        out[lang.toLowerCase()] = l as CefrLevel;
      }
      return { key: k, value: out };
    }
    case 'employment':
      return {
        key: k,
        value: list(value).map((v) => oneOf(EMPLOYMENT_TYPES, v, 'employment type')),
      };
    case 'dealbreakers':
      return { key: k, value: list(value).map((v) => oneOf(DEALBREAKERS, v, 'dealbreaker')) };
    case 'threshold': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 100) {
        throw new PreferenceError('threshold is a whole number from 0 to 100');
      }
      return { key: k, value: n };
    }
    case 'weights':
      throw new PreferenceError('use `weight.<component> <n>` or `weights reset`');
  }
}
