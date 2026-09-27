// Bounded decisions: "is this field the salary?", "which option means No?", "is this posting
// still open?". Asked as Choice questions of the role's provider (Jev by default), batched per
// call; answers below the role's confidence threshold, and everything when Jev is off, go to
// the fallback model (claude:haiku) in ONE structured run.
import { z } from 'zod';
import type { Role } from './roles.ts';

export interface ChoiceQuestion {
  /** The question; an object keeps data apart from the question text (Jev reads both). */
  instructions: string | Record<string, unknown>;
  /** Option id → what it means (null: the id says it all). */
  options: Record<string, string | null>;
}

export interface DecideRequest {
  /** What the questions are about. Kept small: Jev degrades on large irrelevant state. */
  state: unknown;
  questions: Record<string, ChoiceQuestion>;
  taskId: number | null;
  signal: AbortSignal;
  progress?(message: string): void;
}

export interface Decision {
  choice: string;
  /** Jev's confidence; 1 for the fallback model's answer. */
  confidence: number;
  /** jev · claude:haiku · … */
  by: string;
  /** At or above the role's threshold (or from the fallback). Callers act only on sure answers. */
  sure: boolean;
}

export interface DecideResult {
  answers: Record<string, Decision>;
  /** Why some questions have no sure answer (Jev errors, fallback failures). */
  problems: string[];
  /** The fallback model hit a subscription limit; unsure answers stay unsure. */
  limit: { provider: string; until: Date } | null;
}

export type Decide = (role: Role, req: DecideRequest) => Promise<DecideResult>;

export const decisionSchema = z
  .object({
    answers: z.array(
      z
        .object({
          question: z.string().describe('The question id, exactly as given in brackets'),
          choice: z.string().describe('One of the option ids listed under that question'),
        })
        .strict(),
    ),
  })
  .strict();
export type DecisionOutput = z.infer<typeof decisionSchema>;

export const DECIDE_SYSTEM = `You make small, bounded decisions for Applyant, a job-application tool.
Each question lists its options by id. Answer every question with exactly one option id from its own list.
Read the context literally and don't guess beyond it. When no option fits well, pick the closest one.`;

function render(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 1);
}

export function decidePrompt(state: unknown, questions: Record<string, ChoiceQuestion>): string {
  const parts = ['Context:', render(state), '', 'Questions:'];
  for (const [id, q] of Object.entries(questions)) {
    parts.push(`[${id}] ${render(q.instructions)}`, '  options:');
    for (const [option, meaning] of Object.entries(q.options)) {
      parts.push(`  - ${option}${meaning ? `: ${meaning}` : ''}`);
    }
  }
  parts.push(
    '',
    'Answer every question: {"answers": [{"question": "<id>", "choice": "<option id>"}]}',
  );
  return parts.join('\n');
}

/** Every asked question answered once, with one of its own options. */
export function validateDecisions(
  out: DecisionOutput,
  questions: Record<string, ChoiceQuestion>,
): string | null {
  const seen = new Set<string>();
  for (const a of out.answers) {
    const q = questions[a.question];
    if (!q) return `unknown question "${a.question}"`;
    if (!Object.hasOwn(q.options, a.choice)) {
      return `"${a.choice}" is not an option of question ${a.question}`;
    }
    seen.add(a.question);
  }
  const missing = Object.keys(questions).filter((id) => !seen.has(id));
  return missing.length ? `no answer for ${missing.slice(0, 5).join(', ')}` : null;
}

/** Splits questions into Jev requests: at most `max` questions and ~`chars` of JSON each. */
export function batchQuestions(
  questions: Record<string, ChoiceQuestion>,
  max = 40,
  chars = 100_000,
): Array<Record<string, ChoiceQuestion>> {
  const batches: Array<Record<string, ChoiceQuestion>> = [];
  let current: Record<string, ChoiceQuestion> = {};
  let n = 0;
  let size = 0;
  for (const [id, q] of Object.entries(questions)) {
    const s = JSON.stringify(q).length;
    if (n > 0 && (n >= max || size + s > chars)) {
      batches.push(current);
      current = {};
      n = 0;
      size = 0;
    }
    current[id] = q;
    n++;
    size += s;
  }
  if (n > 0) batches.push(current);
  return batches;
}
