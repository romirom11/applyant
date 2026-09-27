// claim_verifier role, knowledge sources: does the candidate's cited commit/PR actually show
// the claimed work? A boolean plus an issue category, one verdict per claim.
import { z } from 'zod';

export const CLAIM_ISSUES = ['none', 'unrelated', 'partial', 'overstated'] as const;

export const claimCheckSchema = z
  .object({
    verdicts: z.array(
      z
        .object({
          // Not .int(): that emits minimum/maximum, which strict mode rejects. A number that
          // isn't a claim's simply matches no claim.
          claim: z.number().describe('The claim number as given'),
          supported: z.boolean(),
          issue: z.enum(CLAIM_ISSUES),
          note: z.string().describe('One short sentence: why'),
        })
        .strict(),
    ),
  })
  .strict();

export type ClaimCheck = z.infer<typeof claimCheckSchema>;
