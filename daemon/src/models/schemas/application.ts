// application_writer and claim_verifier (answers) output schemas. Strict subset: every
// property required, absent values nullable. The writer returns every answer sentence by
// sentence, each with the ids of the facts it relies on; the verifier returns one verdict per
// numbered sentence: a boolean plus an issue category, never a probability.
import { z } from 'zod';

export const DRAFT_STATUSES = ['answered', 'needs_candidate'] as const;

export const writerSchema = z
  .object({
    drafts: z.array(
      z
        .object({
          question: z.string().describe('The question id, exactly as given (q1, q2, …)'),
          status: z
            .enum(DRAFT_STATUSES)
            .describe(
              'needs_candidate when the facts and profile values can not answer it honestly',
            ),
          choice: z
            .string()
            .nullable()
            .describe('For a choice question: exactly one of its options; otherwise null'),
          sentences: z.array(
            z
              .object({
                text: z.string(),
                // Not .int(): that emits minimum/maximum, which strict mode rejects.
                factIds: z
                  .array(z.number())
                  .describe('Ids of the facts this sentence relies on; [] if it claims nothing'),
              })
              .strict(),
          ),
          missing: z
            .string()
            .nullable()
            .describe('For needs_candidate: what the candidate has to tell; otherwise null'),
          adaptedFrom: z
            .string()
            .nullable()
            .describe('The id of the prior answer whose facts this reuses (answer:<id>), or null'),
        })
        .strict(),
    ),
  })
  .strict();
export type WriterOutput = z.infer<typeof writerSchema>;
export type Draft = WriterOutput['drafts'][number];

/** unsupported: the sentence claims something about the candidate that no cited fact shows. */
export const ANSWER_ISSUES = [
  'none',
  'quantity',
  'role',
  'scope',
  'timeframe',
  'unsupported',
] as const;
export type AnswerIssue = (typeof ANSWER_ISSUES)[number];

export const answerCheckSchema = z
  .object({
    checks: z.array(
      z
        .object({
          sentence: z.number().describe('The sentence number as given'),
          supported: z.boolean(),
          issue: z.enum(ANSWER_ISSUES),
          note: z
            .string()
            .describe('One short sentence, e.g. "fact: a team of 4 · sentence: a team of 10"'),
        })
        .strict(),
    ),
  })
  .strict();
export type AnswerCheck = z.infer<typeof answerCheckSchema>;
