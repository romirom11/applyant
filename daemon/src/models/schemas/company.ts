// researcher (phase 12): one company's profile from web research. Every finding and every red
// flag carries the URLs it came from; what the web doesn't show stays an empty list, never a
// guess. The same object is stored as `companies.profile`.
import { z } from 'zod';

const finding = z
  .object({
    text: z.string().describe('One fact, in one or two plain sentences'),
    date: z
      .string()
      .nullable()
      .describe('When it happened or was reported (YYYY-MM or YYYY-MM-DD), if it matters'),
    sources: z
      .array(z.string())
      .describe('The URL(s) of the pages that say it (at least one); no search pages'),
  })
  .strict();

export const RED_FLAG_KINDS = [
  'layoffs',
  'reviews',
  'outstaffing',
  'pay',
  'funding',
  'legal',
  'other',
] as const;
export type RedFlagKind = (typeof RED_FLAG_KINDS)[number];

export const RED_FLAG_SEVERITIES = ['low', 'medium', 'high'] as const;
export type RedFlagSeverity = (typeof RED_FLAG_SEVERITIES)[number];

const redFlag = z
  .object({
    kind: z
      .enum(RED_FLAG_KINDS)
      .describe(
        'layoffs (recent), reviews (poor employee reviews), outstaffing (an outstaffing or body-shop business presented as a product company), pay (out of line with the market), funding (running out, down round, distress), legal, other',
      ),
    severity: z
      .enum(RED_FLAG_SEVERITIES)
      .describe(
        'high: a real reason to think twice (large layoffs this year, a pattern of very poor reviews); medium: worth asking about; low: minor or old',
      ),
    text: z.string().describe('What the flag is, specifically, with the number or date'),
    sources: z.array(z.string()).describe('The URL(s) that show it (at least one)'),
  })
  .strict();

export const companyResearchSchema = z
  .object({
    name: z.string().describe("The company's name as it presents itself"),
    website: z.string().nullable().describe("The company's own website"),
    summary: z
      .string()
      .describe(
        'Two to four sentences: what the company does, for whom, how it makes money, how big and how far along it is. Plain, factual, no praise',
      ),
    product: z.array(finding).describe('Product and business model'),
    funding: z.array(finding).describe('Funding rounds, investors, revenue or profitability'),
    size: z.array(finding).describe('Headcount and where the team is'),
    founders: z.array(finding).describe('Founders and leadership'),
    stack: z.array(finding).describe('Technology stack'),
    news: z.array(finding).describe('Recent news (the last 12 months first)'),
    layoffs: z.array(finding).describe('Layoffs, with dates and numbers'),
    reviews: z
      .array(finding)
      .describe('Employee reviews (Glassdoor, Kununu, Blind…): rating and recurring themes'),
    remote: z.array(finding).describe('Remote culture and where they hire'),
    salary: z.array(finding).describe('Salary data for engineering roles, where available'),
    redFlags: z
      .array(redFlag)
      .describe('Only what the sources show; none is a fine answer. Each is also in a section'),
    note: z.string().nullable().describe('What you could not find or verify, if anything'),
  })
  .strict();

export type CompanyResearch = z.infer<typeof companyResearchSchema>;
export type CompanyFinding = z.infer<typeof finding>;
export type RedFlag = z.infer<typeof redFlag>;

/** The stored profile is the researcher's output as validated. */
export type CompanyProfile = CompanyResearch;

export const COMPANY_SECTIONS = [
  'product',
  'funding',
  'size',
  'founders',
  'stack',
  'news',
  'layoffs',
  'reviews',
  'remote',
  'salary',
] as const;
export type CompanySection = (typeof COMPANY_SECTIONS)[number];
