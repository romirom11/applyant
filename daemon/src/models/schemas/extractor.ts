// extractor role, knowledge sources: one source (CV, repo digest, page) → projects + facts
// with evidence. Strict subset only (see schemas.strict.test.ts): absent values are
// nullable, never optional; lengths and counts are checked after parsing.
import { z } from 'zod';
import { FACT_KINDS } from '../../db/schema.ts';

export const sourceExtractionSchema = z
  .object({
    projects: z.array(
      z
        .object({
          name: z.string().describe('Project, product or position name as the source writes it'),
          summary: z.string().nullable().describe('One or two sentences on what it is'),
          role: z.string().nullable().describe("The candidate's role, as stated"),
          period: z.string().nullable().describe('e.g. "2021–2023", as stated'),
          stack: z.array(z.string()).describe('Technologies named for this project'),
        })
        .strict(),
    ),
    facts: z.array(
      z
        .object({
          text: z.string().describe('One atomic claim, faithful to the source'),
          kind: z.enum(FACT_KINDS),
          project: z
            .string()
            .nullable()
            .describe('Name of the project (from `projects`) the fact belongs to; null if none'),
          evidence: z.array(
            z
              .object({
                locator: z.string().describe('Where in the source: see the locator rules'),
                quote: z.string().nullable().describe('Short verbatim excerpt, or null'),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

export type SourceExtraction = z.infer<typeof sourceExtractionSchema>;
