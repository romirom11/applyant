// The score shapes every client renders, and what a scored posting stores.
import type { PostingExtraction, Verdict } from '../../models/schemas/posting.ts';

/** An extraction as stored: the model's reading (structured page data is applied at scoring). */
export type StoredExtraction = PostingExtraction;

export const COMPONENT_KEYS = [
  'must',
  'nice',
  'role',
  'location',
  'remote',
  'salary',
  'language',
  'employment',
] as const;
export type ComponentKey = (typeof COMPONENT_KEYS)[number];

export interface Component {
  key: ComponentKey;
  /** Effective weight (preferences × bounded feedback); 0 when no preference applies. */
  weight: number;
  /** 0–1. */
  value: number;
  note: string | null;
  /** The posting doesn't say enough to compare: shown, but not counted in the score. */
  uncertain: boolean;
  /**
   * How much of this component's weight·value counts: 1, except logistics (location, remote,
   * salary, language, employment) when core fit is poor, so they can't lift a weak match.
   */
  scale: number;
}

/** Logistics components: they can't make up for a poor core fit. */
export const LOGISTICS_KEYS: readonly ComponentKey[] = [
  'location',
  'remote',
  'salary',
  'language',
  'employment',
];

/** unknown: a condition (travel, time zones, …) the candidate's facts can't answer; asked instead. */
export type MatchVerdict = Verdict | 'unknown';

export interface RequirementMatch {
  text: string;
  must: boolean;
  verdict: MatchVerdict;
  factIds: number[];
}

/** A match as stored on the posting: with the matcher's note and the cache key it was made for. */
export interface StoredMatch extends RequirementMatch {
  note: string | null;
  /** Hash of the requirement and the facts the matcher saw; a new key means ask again. */
  key: string;
}

export interface ScoreResult {
  score: number;
  /** must-haves × role fit, 0–1; null when neither is known. */
  coreFit: number | null;
  breakdown: Component[];
  dealbreakers: string[];
}

export type Weights = Record<ComponentKey, number>;
