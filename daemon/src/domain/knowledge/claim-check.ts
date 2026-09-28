// The claim check for code sources: after the authorship rule (the cited commit or PR is the
// candidate's), a separate `claim_verifier` run asks whether the cited work *is* the claimed
// work. A candidate commit on an unrelated subject can't carry someone else's feature.
//
// The verifier is not the extractor: it runs as its own process and sees only the claims
// and the cited items (subject, message, changed paths; for a PR, only the candidate's own
// commits in it), never the digest or the extractor's reasoning. Claims go in batches, so a
// repository costs one or a few cheap calls. A claim without a verdict counts as unsupported.
import type { AgentRunner } from '../../models/agent-runner.ts';
import type { Provider } from '../../models/roles.ts';
import { type ClaimCheck, claimCheckSchema } from '../../models/schemas/index.ts';
import type { RefDetail } from './sources/material.ts';

export const CLAIM_BATCH = 60;
const MAX_PATHS = 12;

export const CLAIM_CHECK_SYSTEM = `You check claims about a software engineer against the commits and pull requests cited for them. The claims were written by another model from a repository digest and may credit the engineer with work the cited items don't show.

For each claim decide whether the cited items show the claimed work: all of it.
- supported = true only when every part of the claim (each feature, component, technology, number and the scope of the work) is shown by at least one cited item, through its subject, message or changed file paths.
- issue "unrelated": the cited items are about different work.
- issue "partial": some parts of the claim are shown, others are not.
- issue "overstated": the cited items show smaller or different work than claimed (a fix claimed as building the feature, a number that isn't there, one change claimed as a whole system).
- issue "none" when supported.
Judge only by the cited items, not by what the engineer probably did. Commit messages may be in another language (often Ukrainian); a message that means the same thing counts. Changed paths show which component was touched but not, on their own, what was built.
Return one verdict per claim, with its number and a one-sentence note.`;

export interface ClaimToCheck {
  text: string;
  kind: string;
  refs: RefDetail[];
}

export interface Verdict {
  supported: boolean;
  issue: ClaimCheck['verdicts'][number]['issue'];
  note: string;
}

export function claimCheckPrompt(claims: ClaimToCheck[], offset = 0): string {
  const blocks = claims.map((c, i) => {
    const cited = c.refs
      .map((r) => {
        const lines = [`- ${r.ref}: ${r.title}`];
        if (r.body) lines.push(`  message: ${r.body}`);
        if (r.paths.length) {
          const more = r.paths.length > MAX_PATHS ? `, +${r.paths.length - MAX_PATHS} more` : '';
          lines.push(`  files: ${r.paths.slice(0, MAX_PATHS).join(', ')}${more}`);
        }
        return lines.join('\n');
      })
      .join('\n');
    return `Claim ${offset + i + 1} (${c.kind}): ${c.text}\nCited:\n${cited}`;
  });
  return `${blocks.join('\n\n')}\n\nReturn a verdict for each of the ${claims.length} claims (numbers ${offset + 1}–${offset + claims.length}).`;
}

export type ClaimCheckResult =
  | { kind: 'ok'; verdicts: Array<Verdict | null> }
  | { kind: 'limit'; provider: Provider; until: Date }
  | { kind: 'failed'; reason: string };

/** Verdicts in claim order; null where the verifier gave none. */
export async function checkClaims(
  claims: ClaimToCheck[],
  models: AgentRunner,
  o: { taskId: number | null; signal: AbortSignal; progress?: (message: string) => void },
): Promise<ClaimCheckResult> {
  const verdicts: Array<Verdict | null> = claims.map(() => null);
  for (let start = 0; start < claims.length; start += CLAIM_BATCH) {
    const batch = claims.slice(start, start + CLAIM_BATCH);
    const res = await models.run('claim_verifier', {
      schema: claimCheckSchema,
      system: CLAIM_CHECK_SYSTEM,
      prompt: claimCheckPrompt(batch, start),
      taskId: o.taskId,
      signal: o.signal,
      ...(o.progress ? { progress: o.progress } : {}),
    });
    if (res.kind === 'limit') return { kind: 'limit', provider: res.provider, until: res.until };
    if (res.kind === 'failed') return { kind: 'failed', reason: res.reason };
    for (const v of res.output.verdicts) {
      const i = v.claim - 1;
      if (i < start || i >= start + batch.length) continue;
      verdicts[i] = { supported: v.supported && v.issue === 'none', issue: v.issue, note: v.note };
    }
  }
  return { kind: 'ok', verdicts };
}
