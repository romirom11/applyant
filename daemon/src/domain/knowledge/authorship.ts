// The authorship rule for code sources, applied after the extractor and without a model:
// a fact that says what the candidate did (personal_contribution, role, impact, skill) must
// cite at least one commit by the candidate's identities, or a PR containing one. Anything
// else in a repo is team context, however the model classified it. Evidence citing SHAs or
// PRs that aren't in the repository is dropped, so a fact can't borrow credibility from an
// invented reference.
//
// Authorship is necessary, not sufficient: the cited work also has to be the claimed work.
// That is checked by the separate claim check (claim-check.ts) over the refs collected here.
import type { FactKind } from '../../db/schema.ts';
import type { Authorship } from './sources/material.ts';

export const CANDIDATE_KINDS: ReadonlySet<FactKind> = new Set([
  'personal_contribution',
  'role',
  'impact',
  'skill',
]);

/** Prefixed to a candidate-kind fact that had to become team context. */
export const TEAM_PREFIX = 'By other contributors: ';

export interface CitedFact {
  text: string;
  kind: FactKind;
  evidence: Array<{ locator: string | null; excerpt: string | null }>;
}

export interface AuthorshipResult<F extends CitedFact> {
  fact: F;
  /** Set when the kind was changed to team_context. */
  downgraded: boolean;
  /** Keys into `Authorship.refs` of the candidate's own commits/PRs the fact cites. */
  candidateRefs: string[];
}

const COMMIT = /^commit:\s*([0-9a-f]{7,40})\b/i;
const PR = /^pr:\s*#?(\d+)\b/i;

function resolveSha(prefix: string, shas: Set<string>): string | null {
  const p = prefix.toLowerCase();
  if (shas.has(p)) return p;
  let found: string | null = null;
  for (const sha of shas) {
    if (sha.startsWith(p)) {
      if (found) return null; // ambiguous prefix
      found = sha;
    }
  }
  return found;
}

export function applyAuthorship<F extends CitedFact>(fact: F, a: Authorship): AuthorshipResult<F> {
  const candidateRefs: string[] = [];
  const evidence: CitedFact['evidence'] = [];
  for (const e of fact.evidence) {
    const loc = e.locator?.trim() ?? '';
    const commit = COMMIT.exec(loc);
    if (commit?.[1]) {
      const mine = resolveSha(commit[1], a.candidateShas);
      const theirs = mine ? null : resolveSha(commit[1], a.otherShas);
      if (!mine && !theirs) continue; // not a commit of this repository
      if (mine) candidateRefs.push(mine);
      evidence.push({ ...e, locator: `commit:${(mine ?? theirs ?? '').slice(0, 12)}` });
      continue;
    }
    const pr = PR.exec(loc);
    if (pr?.[1]) {
      const n = Number(pr[1]);
      if (a.candidatePrs.has(n)) {
        candidateRefs.push(`pr:${n}`);
        evidence.push({ ...e, locator: `pr:#${n}` });
      } else if (a.otherPrs.has(n)) {
        // Opened by the candidate but written by others: team evidence only.
        evidence.push({ ...e, locator: `pr:#${n}` });
      }
      // Any other number wasn't listed to the model, so it is invented.
      continue;
    }
    evidence.push(e);
  }

  const refs = [...new Set(candidateRefs)];
  if (CANDIDATE_KINDS.has(fact.kind) && refs.length === 0) {
    return {
      fact: { ...fact, kind: 'team_context', text: teamText(fact.text), evidence },
      downgraded: true,
      candidateRefs: [],
    };
  }
  return { fact: { ...fact, evidence }, downgraded: false, candidateRefs: refs };
}

export function teamText(text: string): string {
  return text.startsWith(TEAM_PREFIX) ? text : `${TEAM_PREFIX}${text}`;
}
