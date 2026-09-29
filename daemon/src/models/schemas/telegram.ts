// extractor role, Telegram job channels (phase 15): a batch of channel posts → which are job
// postings, and for those the posting's role, company, salary, location and contact. Strict
// subset only: absent values are nullable, never optional.
import { z } from 'zod';

export const telegramPostsSchema = z
  .object({
    posts: z.array(
      z
        .object({
          post: z.string().describe('The post id exactly as given (the number after "post ")'),
          job: z
            .boolean()
            .describe(
              'true only for a post that offers one job (or one role) to apply for; false for ads, courses, news, digests of many jobs, channel promotion, résumés of people seeking work',
            ),
          role: z.string().nullable().describe('The role title as the post writes it'),
          company: z.string().nullable().describe('The hiring company, not the channel'),
          salary: z
            .string()
            .nullable()
            .describe('The stated salary or rate with its currency and period, as written'),
          location: z
            .string()
            .nullable()
            .describe('Where the work is: city/country, "Remote", "Remote (EU)", as stated'),
          remote: z.boolean().nullable().describe('true remote, false on-site/hybrid, null unsaid'),
          contact: z
            .string()
            .nullable()
            .describe(
              'Who to write to, as stated: a Telegram @username or an email address; null if none',
            ),
          applyUrl: z
            .string()
            .nullable()
            .describe(
              "The link to the job's own page or application form, copied exactly from the post (the <…> after the link text); null if none",
            ),
        })
        .strict(),
    ),
  })
  .strict();

export type TelegramPosts = z.infer<typeof telegramPostsSchema>;
export type TelegramPostJudgement = TelegramPosts['posts'][number];
