// email_classify (phase 13): what a reply to an application is. On-device by default (the
// `apple` provider asks applyant-native); a cloud model answers only when the candidate routes
// the role there (`applyant config roles set email_classify claude:haiku`).
import { z } from 'zod';
import { EMAIL_LABELS } from '../../db/schema.ts';

export const emailClassSchema = z
  .object({
    label: z
      .enum(EMAIL_LABELS)
      .describe(
        'rejection · interview (an invitation, a call, a test task or next steps) · offer · acknowledgement (application received) · security_code (a one-time code to finish submitting) · other (not about a job application) · unknown (cannot tell)',
      ),
    confidence: z.number().describe('0–1: how sure the label is'),
    language: z.string().nullable().describe('ISO 639-1 language of the email, if known'),
  })
  .strict();
export type EmailClass = z.infer<typeof emailClassSchema>;
