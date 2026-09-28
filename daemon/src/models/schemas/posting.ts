// extractor role, postings: the posting text → the structured fields the score is computed
// from. Extracted once per posting text and cached; the number itself never comes from a model.
// Strict subset only: absent values are nullable, never optional; ISO codes and counts are
// normalised after parsing (domain/scoring/extract.ts).
import { z } from 'zod';

export const ROLE_FAMILIES = [
  'ai_ml',
  'backend',
  'fullstack',
  'frontend',
  'data',
  'platform',
  'mobile',
  'security',
  'founding',
  'management',
  'research',
  'other',
] as const;
export type RoleFamily = (typeof ROLE_FAMILIES)[number];

export const SENIORITIES = [
  'intern',
  'junior',
  'mid',
  'senior',
  'lead',
  'staff',
  'principal',
  'head',
] as const;
export type Seniority = (typeof SENIORITIES)[number];

export const WORKPLACES = ['remote', 'hybrid', 'onsite', 'unknown'] as const;
export type Workplace = (typeof WORKPLACES)[number];

export const REMOTE_REGIONS = [
  'worldwide',
  'europe',
  'eu',
  'emea',
  'uk',
  'americas',
  'north_america',
  'us',
  'latam',
  'apac',
  'middle_east',
  'africa',
] as const;
export type RemoteRegion = (typeof REMOTE_REGIONS)[number];

export const SALARY_PERIODS = ['hour', 'day', 'month', 'year'] as const;
export type SalaryPeriod = (typeof SALARY_PERIODS)[number];

export const LANGUAGE_LEVELS = ['basic', 'professional', 'fluent', 'native'] as const;
export type LanguageLevel = (typeof LANGUAGE_LEVELS)[number];

/**
 * skill: experience, knowledge or ability the candidate's facts can show.
 * condition: availability, willingness or circumstance (travel, relocation, time-zone overlap,
 * on-call, work permit, start date) that no fact can answer: the candidate is asked instead.
 */
export const REQUIREMENT_KINDS = ['skill', 'condition'] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

export const EMPLOYMENT_TYPES = [
  'full_time',
  'part_time',
  'contract',
  'freelance',
  'internship',
  'temporary',
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const postingExtractionSchema = z
  .object({
    title: z.string().nullable().describe('The job title as the posting writes it'),
    company: z.string().nullable().describe('The hiring company (not the job board or agency)'),
    summary: z.string().describe('One sentence: what the role is about'),
    seniority: z
      .enum([...SENIORITIES, 'unknown'])
      .describe('Seniority the posting asks for; "unknown" when it does not say'),
    roleFamilies: z
      .array(z.enum(ROLE_FAMILIES))
      .describe('The kinds of engineering work the role is, most important first'),
    requirements: z.array(
      z
        .object({
          text: z
            .string()
            .describe('One requirement, short and self-contained, as the posting states it'),
          must: z
            .boolean()
            .describe(
              'false only when the posting explicitly marks it as nice-to-have / bonus / preferred / a plus; otherwise true',
            ),
          kind: z
            .enum(REQUIREMENT_KINDS)
            .describe(
              'skill: something experience can show; condition: availability, willingness or circumstance (travel, relocation, time zones, on-call, work permit, start date)',
            ),
        })
        .strict(),
    ),
    workplace: z.enum(WORKPLACES),
    remoteRegions: z
      .array(z.enum(REMOTE_REGIONS))
      .describe('Regions a remote hire may work from, as stated; empty when not stated'),
    remoteCountries: z
      .array(z.string())
      .describe('ISO 3166-1 alpha-2 codes of countries a remote hire may work from, as stated'),
    offices: z.array(
      z
        .object({
          city: z.string().nullable(),
          country: z.string().nullable().describe('ISO 3166-1 alpha-2 code'),
        })
        .strict(),
    ),
    salary: z
      .object({
        min: z.number().nullable(),
        max: z.number().nullable(),
        currency: z.string().nullable().describe('ISO 4217 code, e.g. EUR'),
        period: z.enum(SALARY_PERIODS).nullable(),
        basis: z.enum(['gross', 'net']).nullable(),
        text: z.string().describe('The salary exactly as the posting writes it'),
      })
      .strict()
      .nullable()
      .describe('null when the posting states no salary'),
    languages: z.array(
      z
        .object({
          language: z.string().describe('ISO 639-1 code, e.g. en, de'),
          level: z.enum(LANGUAGE_LEVELS).nullable(),
          required: z.boolean(),
        })
        .strict(),
    ),
    postingLanguage: z
      .string()
      .nullable()
      .describe('ISO 639-1 code of the language the posting is written in'),
    employment: z.enum(EMPLOYMENT_TYPES).nullable(),
    outstaffing: z
      .boolean()
      .nullable()
      .describe(
        'true when the employer is an outstaffing / outsourcing agency placing the hire with a client; null when unclear',
      ),
  })
  .strict();

export type PostingExtraction = z.infer<typeof postingExtractionSchema>;

// matcher role: each requirement against the facts retrieved for it.
export const VERDICTS = ['strong', 'partial', 'missing'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const matcherSchema = z
  .object({
    matches: z.array(
      z
        .object({
          // Not .int(): that emits minimum/maximum, which strict mode rejects.
          requirement: z.number().describe('The requirement number as given'),
          verdict: z.enum(VERDICTS),
          factIds: z
            .array(z.number())
            .describe("Ids of the facts (from this requirement's list) that show it"),
          note: z.string().describe('One short sentence: why'),
        })
        .strict(),
    ),
  })
  .strict();

export type MatcherOutput = z.infer<typeof matcherSchema>;
