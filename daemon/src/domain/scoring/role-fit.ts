// Is this posting one of the roles the candidate is after? The candidate's roles are job
// titles in their own words ("CFO", "Chef", "Backend Engineer"), so no fixed list can compare
// them: each posting is judged once by the role_fit decision (Jev by default, claude:haiku
// when Jev is off or unsure) and the verdict is stored with a key of the roles and the
// extraction it was made for. score() only reads it. Changing the roles makes the key stale;
// open postings are then judged again (one small decision each, no matcher run).
import { createHash } from 'node:crypto';
import type { Decide } from '../../models/decide.ts';
import type { PostingExtraction } from '../../models/schemas/posting.ts';
import type { RoleFit, RoleVerdict } from './types.ts';

export const ROLE_FIT_VERSION = 'role-fit/1';

const VERDICTS: readonly RoleVerdict[] = ['same', 'close', 'different'];

export function roleFitKey(roles: string[], extractionKey: string | null): string {
  const h = createHash('sha256').update(ROLE_FIT_VERSION).update('\0');
  h.update(extractionKey ?? '').update('\0');
  for (const r of roles.map((r) => r.toLowerCase()).sort()) h.update(r).update('\0');
  return h.digest('hex');
}

/** The stored verdict, if it was made for these roles and this extraction. */
export function currentRoleFit(
  row: { roleFit: RoleFit | null; extractionKey: string | null },
  roles: string[],
): RoleFit | null {
  if (roles.length === 0 || !row.roleFit) return null;
  return row.roleFit.key === roleFitKey(roles, row.extractionKey) ? row.roleFit : null;
}

export interface RoleFitResult {
  /** Null when the decision wasn't sure (the score then leaves the role out). */
  fit: RoleFit | null;
  /** The fallback model hit a subscription limit. */
  limit: { provider: string; until: Date } | null;
}

/** One bounded decision: the job against the candidate's roles. */
export async function judgeRoleFit(
  decide: Decide,
  posting: { title: string | null; extraction: PostingExtraction; extractionKey: string | null },
  roles: string[],
  o: { taskId: number | null; signal: AbortSignal },
): Promise<RoleFitResult> {
  const e = posting.extraction;
  const res = await decide('role_fit', {
    state: {
      job: {
        title: e.title ?? posting.title,
        about: e.summary,
        asks_for: e.requirements
          .filter((r) => r.must)
          .slice(0, 6)
          .map((r) => r.text),
      },
      roles_the_candidate_is_after: roles,
    },
    questions: {
      role: {
        instructions:
          'Is this job one of the roles the candidate is after? Judge the kind of work, not the seniority, the company or the wording of the title.',
        options: {
          same: 'Yes: the same occupation as one of those roles, under this or another title',
          close:
            'A neighbouring role: much the same skills and daily work, a job someone in one of those roles would plausibly take',
          different: 'A different kind of work',
        },
      },
    },
    taskId: o.taskId,
    signal: o.signal,
  });
  const answer = res.answers.role;
  if (!answer?.sure || !VERDICTS.includes(answer.choice as RoleVerdict)) {
    return { fit: null, limit: res.limit };
  }
  return {
    fit: {
      key: roleFitKey(roles, posting.extractionKey),
      verdict: answer.choice as RoleVerdict,
      by: answer.by,
    },
    limit: res.limit,
  };
}
