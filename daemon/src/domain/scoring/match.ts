// The matcher: each requirement against the facts hybrid retrieval found for it.
//
//   per requirement:  top-k facts (BM25 + vectors, RRF) → cache key = requirement + those facts
//   cached key        → reuse the stored verdict (no model call)
//   no facts at all   → missing (no model call)
//   a condition       → unknown: travel, time zones, on-call… no fact can show them; the
//                       candidate is asked instead (no retrieval, no model call)
//   the rest          → ONE matcher run for all of them (claude:sonnet by default)
//
// So a fact that is added, corrected or rejected changes the key only of the requirements
// it was retrieved for, and only those are asked again. Confirming a fact doesn't: whether a
// fact shows a skill doesn't depend on its status, so status is neither shown nor keyed.
// After a knowledge change, rematch.ts compares these keys for open postings and re-scores
// only those with a changed key, so a change never re-runs the matcher for every posting.
import { createHash } from 'node:crypto';
import type { ReadExec } from '../../db/read-pool.ts';
import type { Embedder } from '../../models/embeddings.ts';
import type { MatcherOutput, RequirementKind } from '../../models/schemas/posting.ts';
import { type FactHit, retrieveFacts } from '../knowledge/retrieve.ts';
import type { StoredMatch } from './types.ts';

export const MATCH_PROMPT_VERSION = 'match/1';
/** Facts retrieved per requirement. */
export const FACTS_PER_REQUIREMENT = 8;

export const MATCHER_SYSTEM = `You judge whether a job candidate meets job requirements, using only the facts listed under each requirement. The facts come from the candidate's CV, repositories and their own statements; each has an id, a kind and the project it belongs to.

For each requirement give a verdict:
- strong: the facts clearly show the candidate meets the whole requirement (the named technology or skill used in real work, stated years or scale that reach what is asked).
- partial: the facts show something close but not all of it: an adjacent technology, less experience or scale than asked, the skill only mentioned without real use, or only team context.
- missing: nothing in the listed facts shows it.

Rules:
- Cite in factIds the ids (from that requirement's own list) that support the verdict; strong and partial need at least one. Cite nothing for missing.
- Facts of kind team_context describe other people's or the team's work, not the candidate's: on their own they make a requirement partial at most.
- Don't infer experience the facts don't state. Years of experience come only from stated periods or stated years; never assume.
- The note is one short sentence naming what the facts show or lack.`;

export interface Requirement {
  text: string;
  must: boolean;
  /** Absent in extractions made before conditions were told apart: a skill. */
  kind?: RequirementKind;
}

export const CONDITION_NOTE = "a condition your facts can't show: you'll be asked";

export interface Candidates {
  requirement: Requirement;
  facts: FactHit[];
  key: string;
}

export function matchKey(req: Requirement, facts: FactHit[]): string {
  const h = createHash('sha256').update(MATCH_PROMPT_VERSION).update('\0');
  h.update(`${req.must ? 'must' : 'nice'}\0${req.text}\0`);
  for (const f of [...facts].sort((a, b) => a.id - b.id)) {
    h.update(`${f.id}\0${f.kind}\0${f.project ?? ''}\0${f.period ?? ''}\0${f.text}\0`);
  }
  return h.digest('hex');
}

/** Retrieves each requirement's facts (one embedding batch, then one query per requirement). */
export async function gatherCandidates(
  requirements: Requirement[],
  deps: { readPool: ReadExec; embedder: Embedder },
  o: { signal: AbortSignal; onEmbedError?: (err: Error) => void },
): Promise<Candidates[]> {
  let vectors: Array<Float32Array | null> = requirements.map(() => null);
  try {
    vectors = await deps.embedder.embed(
      requirements.map((r) => r.text),
      'query',
      o.signal,
    );
  } catch (err) {
    o.signal.throwIfAborted();
    // Keyword retrieval alone still works.
    o.onEmbedError?.(err as Error);
  }
  const out: Candidates[] = [];
  for (const [i, requirement] of requirements.entries()) {
    if (requirement.kind === 'condition') {
      out.push({ requirement, facts: [], key: matchKey(requirement, []) });
      continue;
    }
    const facts = await retrieveFacts(
      deps.readPool,
      { text: requirement.text, vector: vectors[i] ?? null },
      FACTS_PER_REQUIREMENT,
    );
    out.push({ requirement, facts, key: matchKey(requirement, facts) });
  }
  return out;
}

export interface MatchPlan {
  /** Final matches for requirements that need no model call, by index. */
  settled: Map<number, StoredMatch>;
  /** Indexes of requirements to ask the matcher about. */
  ask: number[];
}

export function planMatches(candidates: Candidates[], cached: StoredMatch[] | null): MatchPlan {
  const byKey = new Map((cached ?? []).map((m) => [m.key, m]));
  const settled = new Map<number, StoredMatch>();
  const ask: number[] = [];
  candidates.forEach((c, i) => {
    const hit = byKey.get(c.key);
    if (c.requirement.kind === 'condition') {
      settled.set(i, {
        text: c.requirement.text,
        must: c.requirement.must,
        verdict: 'unknown',
        factIds: [],
        note: CONDITION_NOTE,
        key: c.key,
      });
    } else if (hit) settled.set(i, { ...hit, text: c.requirement.text, must: c.requirement.must });
    else if (c.facts.length === 0) {
      settled.set(i, {
        text: c.requirement.text,
        must: c.requirement.must,
        verdict: 'missing',
        factIds: [],
        note: 'no related facts in your knowledge base',
        key: c.key,
      });
    } else ask.push(i);
  });
  return { settled, ask };
}

function factLine(f: FactHit): string {
  const where = [f.project, f.period].filter(Boolean).join(', ');
  return `  #${f.id} [${f.kind}${where ? ` · ${where}` : ''}] ${f.text}`;
}

/** Requirements are numbered 1..n in the order given. */
export function matcherPrompt(asked: Candidates[]): string {
  const blocks = asked.map(
    (c, i) =>
      `Requirement ${i + 1} (${c.requirement.must ? 'must-have' : 'nice-to-have'}): ${c.requirement.text}\nFacts:\n${c.facts.map(factLine).join('\n')}`,
  );
  return `${blocks.join('\n\n')}\n\nReturn one verdict for each of the ${asked.length} requirements (numbers 1–${asked.length}).`;
}

export function validateMatcherOutput(out: MatcherOutput, count: number): string | null {
  const answered = new Set(out.matches.map((m) => m.requirement));
  for (let n = 1; n <= count; n++) {
    if (!answered.has(n)) return `no verdict for requirement ${n}`;
  }
  return null;
}

/**
 * The matcher's verdicts as stored matches. Fact ids outside a requirement's own list are
 * dropped; a strong or partial verdict left with no fact becomes missing.
 */
export function applyMatcherOutput(asked: Candidates[], out: MatcherOutput): StoredMatch[] {
  return asked.map((c, i) => {
    const m = out.matches.find((x) => x.requirement === i + 1);
    const allowed = new Set(c.facts.map((f) => f.id));
    const factIds = [...new Set((m?.factIds ?? []).filter((id) => allowed.has(id)))];
    const verdict =
      m && m.verdict !== 'missing' && factIds.length === 0 ? 'missing' : (m?.verdict ?? 'missing');
    return {
      text: c.requirement.text,
      must: c.requirement.must,
      verdict,
      factIds: verdict === 'missing' ? [] : factIds,
      note: m?.note.trim() || null,
      key: c.key,
    };
  });
}
