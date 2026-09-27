// Prior answers: what was answered before to a similar question, with the facts each sentence
// relied on and whether it passed its checks. Reuse means reusing checked facts, not copying
// text: the writer sees the facts and says what it adapted from.
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { Conn } from '../../db/client.ts';
import { answerSentences, answers, applications, postings } from '../../db/schema.ts';

export interface PriorAnswer {
  /** answer:<id> */
  id: string;
  question: string;
  company: string | null;
  /** approved · ready_for_review · … */
  stage: string;
  sentences: Array<{ text: string; factIds: number[] }>;
}

const STOP = new Set(
  'a an and are as at be by do does for from have how in is it of on or our that the this to us we what when where which who why will with you your'.split(
    ' ',
  ),
);

export function questionWords(text: string): Set<string> {
  return new Set(
    (
      text
        .toLowerCase()
        .normalize('NFKC')
        .match(/[\p{L}\p{N}]+/gu) ?? []
    ).filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

export function similarity(a: string, b: string): number {
  const x = questionWords(a);
  const y = questionWords(b);
  if (x.size === 0 || y.size === 0) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/**
 * Up to `limit` prior written answers (from other applications) to questions like this one,
 * whose sentences all passed their checks or are the candidate's own edits. Approved ones first.
 */
export function priorAnswers(
  conn: Conn,
  applicationId: number,
  question: string,
  o: { limit?: number; min?: number } = {},
): PriorAnswer[] {
  const rows = conn
    .select({ answer: answers, stage: applications.stage, company: postings.company })
    .from(answers)
    .innerJoin(applications, eq(answers.applicationId, applications.id))
    .innerJoin(postings, eq(applications.postingId, postings.id))
    .where(
      and(
        ne(answers.applicationId, applicationId),
        eq(answers.kind, 'text'),
        eq(answers.status, 'answered'),
      ),
    )
    .all();
  const scored = rows
    .map((r) => ({ r, s: similarity(question, r.answer.question) }))
    .filter((x) => x.s >= (o.min ?? 0.34))
    .sort(
      (a, b) => Number(b.r.stage === 'approved') - Number(a.r.stage === 'approved') || b.s - a.s,
    );
  if (scored.length === 0) return [];
  const sentences = conn
    .select()
    .from(answerSentences)
    .where(
      inArray(
        answerSentences.answerId,
        scored.map((x) => x.r.answer.id),
      ),
    )
    .all();
  const out: PriorAnswer[] = [];
  for (const { r } of scored) {
    const own = sentences.filter((s) => s.answerId === r.answer.id).sort((a, b) => a.idx - b.idx);
    if (own.length === 0 || own.some((s) => s.flag !== 'none')) continue;
    out.push({
      id: `answer:${r.answer.id}`,
      question: r.answer.question,
      company: r.company,
      stage: r.stage,
      sentences: own.map((s) => ({ text: s.text, factIds: s.factIds })),
    });
    if (out.length >= (o.limit ?? 2)) break;
  }
  return out;
}
