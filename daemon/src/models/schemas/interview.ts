// interviewer role: one turn of the agent interview. It reads the candidate's latest answer
// (with the transcript and the project's facts) and returns the facts the answer states, then
// the next question, or null when there is nothing more worth asking. Strict subset only.
import { z } from 'zod';
import { FACT_KINDS } from '../../db/schema.ts';

export const interviewSchema = z
  .object({
    facts: z.array(
      z
        .object({
          text: z
            .string()
            .describe("One atomic claim, in the candidate's own terms; no more than they said"),
          kind: z.enum(FACT_KINDS),
          project: z
            .string()
            .nullable()
            .describe('The slug of the project the fact belongs to (from the list); null if none'),
        })
        .strict(),
    ),
    question: z
      .string()
      .nullable()
      .describe('The next question to the candidate, or null when nothing more is worth asking'),
    about: z
      .string()
      .nullable()
      .describe('What the question is after, in a few words ("team size"); null with no question'),
  })
  .strict();

export type InterviewOutput = z.infer<typeof interviewSchema>;
