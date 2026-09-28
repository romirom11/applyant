// Search roles (phase 11). reader_builder: a listing recipe for one page, flat so it stays in
// the strict subset (turned into a ListingRecipe after parsing). search_planner: strategies to
// add and the boards its web searches found.
import { z } from 'zod';

const locator = z
  .object({
    role: z
      .string()
      .nullable()
      .describe('ARIA role (list, listitem, link, heading, row, article, region…); preferred'),
    name: z
      .string()
      .nullable()
      .describe('Accessible name to match (a case-insensitive substring), or null for any'),
    css: z
      .string()
      .nullable()
      .describe('A CSS selector, only when no role and name work; role and name are then null'),
  })
  .strict();

export const recipeOutputSchema = z
  .object({
    kind: z
      .enum(['locators', 'textPattern', 'none'])
      .describe('none: the page has no job list to read (say why in note)'),
    list: locator
      .nullable()
      .describe(
        'locators: the container(s) of the job list; every match is read, so be precise. null = the whole page',
      ),
    item: locator.nullable().describe('locators: one job inside the list'),
    title: locator
      .nullable()
      .describe("locators: inside an item, the element with the job's title"),
    url: locator
      .nullable()
      .describe(
        "locators: inside an item, the element with the job's link; null = the title's link",
      ),
    location: locator.nullable().describe('locators: inside an item, the location; null if none'),
    team: locator
      .nullable()
      .describe('locators: inside an item, the team or department; null if none'),
    pagination: z
      .enum(['none', 'next', 'scroll'])
      .describe('next: a "next page" control; scroll: more jobs load when scrolling down'),
    next: locator.nullable().describe('pagination next: the "next page" control on the page'),
    pattern: z
      .string()
      .nullable()
      .describe('textPattern: a JavaScript regex over the linked text, one match per job'),
    flags: z.string().nullable().describe('textPattern: regex flags (g is added)'),
    titleGroup: z.number().nullable().describe('textPattern: capture group of the title'),
    urlGroup: z.number().nullable().describe('textPattern: capture group of the link address'),
    locationGroup: z.number().nullable().describe('textPattern: capture group of the location'),
    examples: z
      .array(z.string())
      .describe(
        '3 to 5 job titles exactly as the page shows them, from different parts of the list',
      ),
    jobCount: z
      .number()
      .nullable()
      .describe('How many jobs the page says it has ("42 open roles"), or null'),
    note: z.string().nullable().describe('Anything worth knowing about the page, or why none'),
  })
  .strict();

export type RecipeOutput = z.infer<typeof recipeOutputSchema>;

export const plannerSchema = z
  .object({
    strategies: z.array(
      z
        .object({
          name: z.string().describe('Short, human: "AI Engineer · Remote EU"'),
          queries: z
            .array(z.string())
            .describe(
              'Title phrases: a job matches when every word of one phrase is in its title ("-word" excludes)',
            ),
          locations: z
            .array(z.string())
            .describe('Location words ("remote" matches remote jobs); empty = anywhere'),
          sources: z
            .array(z.string())
            .describe('all, a source kind, a source key from the list, or a board URL from boards'),
          everyHours: z.number().nullable().describe('How often to run (hours); null = every 6'),
          why: z.string().describe('One sentence: what this adds to the existing strategies'),
        })
        .strict(),
    ),
    boards: z.array(
      z
        .object({
          url: z
            .string()
            .describe("A company's job board or careers page (the list, not one posting)"),
          company: z.string().nullable(),
          why: z.string().describe('One sentence: why this company fits the candidate'),
          foundWith: z.string().nullable().describe('The web search that found it'),
        })
        .strict(),
    ),
    searches: z.array(z.string()).describe('Every web search you ran, as typed'),
    note: z.string().nullable(),
  })
  .strict();

export type PlannerOutput = z.infer<typeof plannerSchema>;
