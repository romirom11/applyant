// The checks every drafted sentence goes through before review:
//
//   1 numbers & dates (no model): contradiction → hard flag; absent → confirmable flag
//   2 claim_verifier (claude:haiku by default): a separate run with its own prompt that sees
//     only the sentences and the text of the facts each one cites, never the writer's prompt,
//     draft or reasoning, so it isn't judging its own phrasing. Uncited sentences are checked
//     too: they pass only when they claim nothing about the candidate.
//
// One verifier call covers every unchecked sentence of the application (numbered), in batches.
import type { AgentRunner } from '../../../models/agent-runner.ts';
import type { Provider } from '../../../models/roles.ts';
import { type AnswerCheck, answerCheckSchema } from '../../../models/schemas/application.ts';
import { type CheckFact, checkNumbers, describeCheck } from './numbers.ts';

export const VERIFY_BATCH = 60;

export const ANSWER_CHECK_SYSTEM = `You check sentences written for a job candidate's application against the facts cited for each sentence. The sentences were written by another model and may overstate what the facts say.

For each numbered sentence decide whether its cited facts support everything it says about the candidate:
- supported = true only when every claim about the candidate in the sentence (what they did, their role, scope, numbers, dates, durations, technologies, results) is stated by the cited facts. Wording may differ; meaning may not grow.
- issue "quantity": a number, size, count or amount is larger (or different) than the facts give.
- issue "role": the candidate's part is overstated (led/owned/designed/built where the facts say helped, contributed, was part of a team, or describe the team's work).
- issue "scope": the work is wider or more significant than the facts show (a whole system for one component, production for a prototype, many for one).
- issue "timeframe": dates or durations the facts don't give or that differ.
- issue "unsupported": a claim about the candidate that no cited fact shows at all.
- A sentence with no cited facts is supported only if it claims nothing about the candidate (interest in the company or role, courtesy, a statement about the employer).
- issue "none" when supported.
- The project and role given with a fact are true: "as Tech Lead" or "I founded X" is supported when the fact's project shows that role.
- Statements about the employer, the posting or what the candidate wants next are not claims about the candidate.
Judge only by the cited facts, not by what is plausible. Return one verdict per sentence, with its number and a one-sentence note.`;

export interface SentenceToCheck {
  /** Caller's key (answer id + index). */
  key: string;
  text: string;
  facts: CheckFact[];
}

export interface SentenceResult {
  flag: string;
  note: string | null;
}

export function answerCheckPrompt(items: SentenceToCheck[], offset = 0): string {
  const blocks = items.map((s, i) => {
    const facts = s.facts.length
      ? s.facts
          .map(
            (f) =>
              `  #${f.id}: ${f.text}${[f.project ? `project: ${f.project}` : '', f.period ? `period: ${f.period}` : ''].filter(Boolean).length ? ` (${[f.project ? `project: ${f.project}` : '', f.period ? `period: ${f.period}` : ''].filter(Boolean).join('; ')})` : ''}`,
          )
          .join('\n')
      : '  (no facts cited)';
    return `Sentence ${offset + i + 1}: ${s.text}\nCited facts:\n${facts}`;
  });
  return `${blocks.join('\n\n')}\n\nReturn a verdict for each of the ${items.length} sentences (numbers ${offset + 1}–${offset + items.length}).`;
}

export type VerifyResult =
  | { kind: 'ok'; results: Map<string, SentenceResult> }
  | { kind: 'limit'; provider: Provider; until: Date }
  | { kind: 'failed'; reason: string };

/**
 * Numbers first; then the verifier for every sentence without a hard flag. The strongest
 * finding wins: contradiction > verifier issue > absent number > none.
 */
export async function checkSentences(
  items: SentenceToCheck[],
  models: AgentRunner,
  o: {
    taskId: number | null;
    signal: AbortSignal;
    progress?(message: string): void;
    /** Texts whose numbers need no fact (the profile values stated for this application). */
    allowedNumbers?: string[];
    /** The posting's text: numbers about the employer a sentence may repeat. */
    employerText?: string | null;
  },
): Promise<VerifyResult> {
  const results = new Map<string, SentenceResult>();
  const toVerify: SentenceToCheck[] = [];
  const absent = new Map<string, string>();
  for (const s of items) {
    const n = checkNumbers(
      s.text,
      s.facts,
      o.allowedNumbers ?? [],
      o.employerText ? [o.employerText] : [],
    );
    if (n.kind === 'contradiction') {
      results.set(s.key, { flag: 'contradiction', note: describeCheck(n) });
      continue;
    }
    if (n.kind === 'absent') absent.set(s.key, describeCheck(n) ?? '');
    toVerify.push(s);
  }

  const verdicts = new Map<string, AnswerCheck['checks'][number]>();
  for (let start = 0; start < toVerify.length; start += VERIFY_BATCH) {
    const batch = toVerify.slice(start, start + VERIFY_BATCH);
    o.progress?.(`checking ${batch.length} sentences`);
    const res = await models.run('claim_verifier', {
      schema: answerCheckSchema,
      system: ANSWER_CHECK_SYSTEM,
      prompt: answerCheckPrompt(batch, start),
      taskId: o.taskId,
      signal: o.signal,
      ...(o.progress ? { progress: o.progress } : {}),
    });
    if (res.kind === 'limit') return { kind: 'limit', provider: res.provider, until: res.until };
    if (res.kind === 'failed') return { kind: 'failed', reason: res.reason };
    for (const v of res.output.checks) {
      const s = batch[v.sentence - 1 - start];
      if (s) verdicts.set(s.key, v);
    }
  }

  for (const s of toVerify) {
    const v = verdicts.get(s.key);
    const ok = v ? v.supported && v.issue === 'none' : false;
    if (!ok) {
      const issue = v && v.issue !== 'none' ? v.issue : 'unsupported';
      results.set(s.key, {
        flag: `verifier:${issue}`,
        note: v?.note ?? 'the verifier gave no verdict',
      });
    } else if (absent.has(s.key)) {
      results.set(s.key, { flag: 'absent_number', note: absent.get(s.key) ?? null });
    } else {
      results.set(s.key, { flag: 'none', note: null });
    }
  }
  return { kind: 'ok', results };
}
