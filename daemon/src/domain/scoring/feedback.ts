// Feedback nudges and never forbids. A skip with a reason ("salary too low") raises the weight
// of the component it names, so postings weak on that component drop a little; `interested`
// on a posting weak on some component lowers that component's weight a little. Multipliers
// are capped, so no amount of feedback turns a component into a hard rule.
import { asc } from 'drizzle-orm';
import type { Conn } from '../../db/client.ts';
import { type PostingDecision, postingFeedback } from '../../db/schema.ts';
import { COMPONENT_KEYS, type Component, type ComponentKey, type Weights } from './types.ts';

export const SKIP_STEP = 0.1;
export const INTERESTED_STEP = 0.05;
export const MAX_MULTIPLIER = 1.5;
export const MIN_MULTIPLIER = 0.75;

/** First matching pattern wins: "not remote" is about remote, not location. */
const REASONS: Array<[RegExp, ComponentKey]> = [
  [/salar|pay|money|compensation|rate|underpaid|budget/i, 'salary'],
  [/remote|hybrid|on-?site|office/i, 'remote'],
  [/locat|relocat|country|city|visa|timezone|time zone/i, 'location'],
  [
    /outstaff|outsourc|agency|contract|freelanc|full[- ]?time|part[- ]?time|employment/i,
    'employment',
  ],
  [/german|english|greek|french|language|speak/i, 'language'],
  [/senior|junior|level|title|role|manager|management|lead/i, 'role'],
  [/stack|tech|skill|requirement|experience|framework|language model|domain/i, 'must'],
  [/layoff|laid off|glassdoor|kununu|reviews?\b|culture|reputation|red flag|funding/i, 'company'],
];

/** The score component a free-text skip reason points at, if any. */
export function reasonComponent(reason: string | null): ComponentKey | null {
  if (!reason) return null;
  return REASONS.find(([re]) => re.test(reason))?.[1] ?? null;
}

/** For `interested`: the weakest counted component, when it is clearly weak. */
export function weakestComponent(breakdown: Component[] | null): ComponentKey | null {
  const counted = (breakdown ?? []).filter((c) => c.weight > 0 && !c.uncertain && c.value < 0.6);
  counted.sort((a, b) => a.value - b.value);
  return counted[0]?.key ?? null;
}

export interface FeedbackItem {
  kind: PostingDecision;
  component: string | null;
}

export function listFeedback(conn: Conn): FeedbackItem[] {
  return conn
    .select({ kind: postingFeedback.kind, component: postingFeedback.component })
    .from(postingFeedback)
    .orderBy(asc(postingFeedback.id))
    .all();
}

export function feedbackMultipliers(items: FeedbackItem[]): Weights {
  const m = Object.fromEntries(COMPONENT_KEYS.map((k) => [k, 1])) as Weights;
  for (const f of items) {
    if (!f.component || !(COMPONENT_KEYS as readonly string[]).includes(f.component)) continue;
    const key = f.component as ComponentKey;
    // Clamped at every step, so later feedback always moves the weight from where it is.
    const next = m[key] + (f.kind === 'skipped' ? SKIP_STEP : -INTERESTED_STEP);
    m[key] = Math.round(Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, next)) * 100) / 100;
  }
  return m;
}

export function effectiveWeights(base: Weights, multipliers: Weights): Weights {
  const w = { ...base };
  for (const k of COMPONENT_KEYS) w[k] = Math.round(base[k] * multipliers[k] * 100) / 100;
  return w;
}
