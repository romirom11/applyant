// extractor role, a CV's header: who the candidate is and what they're looking for, read once
// from the CV so the profile and the first preferences don't have to be typed. Strict subset
// only: absent values are nullable, never optional.
import { z } from 'zod';

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'native'] as const;

export const cvHeaderSchema = z
  .object({
    fullName: z.string().nullable().describe("The candidate's name as the CV writes it"),
    email: z.string().nullable(),
    phone: z.string().nullable().describe('As written, with its country code when the CV has it'),
    location: z
      .string()
      .nullable()
      .describe('Where the candidate lives, as the CV writes it, e.g. "Athens, Greece"'),
    city: z.string().nullable().describe('The city they live in, in English, when stated'),
    country: z
      .string()
      .nullable()
      .describe('ISO 3166-1 alpha-2 code of the country they live in, when stated'),
    github: z.string().nullable().describe('GitHub profile URL, when the CV has one'),
    linkedin: z.string().nullable().describe('LinkedIn profile URL, when the CV has one'),
    website: z.string().nullable().describe('Personal site or portfolio URL, when the CV has one'),
    currentTitle: z.string().nullable().describe('Their current or most recent job title'),
    currentCompany: z.string().nullable().describe('Their current or most recent employer'),
    languages: z
      .array(
        z
          .object({
            code: z.string().describe('ISO 639-1 two-letter code, e.g. en, de, uk'),
            level: z
              .enum(LEVELS)
              .describe(
                'The level the CV states, as CEFR (fluent → C1, intermediate → B1, basic → A2); native for a mother tongue',
              ),
          })
          .strict(),
      )
      .describe('Languages the CV says they speak; empty when it names none'),
    targetRoles: z
      .array(z.string())
      .describe(
        'Three to six job titles this person would search for next, as job boards write them (short, no seniority words, no company), most fitting first',
      ),
  })
  .strict();

export type CvHeader = z.infer<typeof cvHeaderSchema>;
