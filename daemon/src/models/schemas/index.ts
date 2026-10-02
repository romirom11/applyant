// Every role output schema, by name. schemas.strict.test.ts checks each one converts to the
// strict JSON Schema subset both SDKs accept (Codex strict mode is the narrower one).
import type { z } from 'zod';
import { decisionSchema } from '../decide.ts';
import { answerCheckSchema, writerSchema } from './application.ts';
import { claimCheckSchema } from './claim-check.ts';
import { companyResearchSchema } from './company.ts';
import { cvPlanSchema } from './cv.ts';
import { cvHeaderSchema } from './cv-header.ts';
import { emailClassSchema } from './email.ts';
import { sourceExtractionSchema } from './extractor.ts';
import { interviewSchema } from './interview.ts';
import { matcherSchema, postingExtractionSchema } from './posting.ts';
import { plannerSchema, recipeOutputSchema } from './search.ts';
import { telegramPostsSchema } from './telegram.ts';

export const ROLE_SCHEMAS: Record<string, z.ZodType> = {
  source_extraction: sourceExtractionSchema,
  cv_header: cvHeaderSchema,
  claim_check: claimCheckSchema,
  application_writer: writerSchema,
  cv_plan: cvPlanSchema,
  answer_check: answerCheckSchema,
  posting_extraction: postingExtractionSchema,
  matcher: matcherSchema,
  interviewer: interviewSchema,
  reader_builder: recipeOutputSchema,
  search_planner: plannerSchema,
  researcher: companyResearchSchema,
  email_classify: emailClassSchema,
  telegram_posts: telegramPostsSchema,
  // Fallback for the Jev decision roles (field_classify, option_match, posting_liveness).
  decision: decisionSchema,
};

export * from './application.ts';
export { CLAIM_ISSUES, type ClaimCheck, claimCheckSchema } from './claim-check.ts';
export * from './company.ts';
export * from './cv.ts';
export * from './cv-header.ts';
export * from './email.ts';
export { type SourceExtraction, sourceExtractionSchema } from './extractor.ts';
export * from './interview.ts';
export * from './posting.ts';
export * from './search.ts';
export * from './telegram.ts';
