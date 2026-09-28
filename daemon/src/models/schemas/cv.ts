// application_writer's CV plan (phase 7). Strict subset, like every role schema. The writer
// picks and orders; it never introduces anything a confirmed fact doesn't say, so every line
// carries the ids of the facts it rests on.
import { z } from 'zod';

const cvLine = z
  .object({
    text: z.string(),
    // Not .int(): that emits minimum/maximum, which strict mode rejects.
    factIds: z.array(z.number()).describe('Ids of the confirmed facts this line rests on'),
  })
  .strict();

export const cvPlanSchema = z
  .object({
    summary: z
      .array(cvLine)
      .describe('2–3 sentences introducing the candidate for this role, each citing its facts'),
    projects: z
      .array(
        z
          .object({
            project: z.string().describe('The project slug, exactly as given'),
            bullets: z.array(cvLine).describe('Most relevant first; 2–5 per project'),
          })
          .strict(),
      )
      .describe('The projects to show, most relevant to this role first'),
    education: z.array(cvLine).describe('One line per education fact worth showing; [] if none'),
    skills: z
      .array(z.string())
      .describe('Technologies and skills named in the given facts, most relevant first'),
  })
  .strict();
export type CvPlanOutput = z.infer<typeof cvPlanSchema>;
