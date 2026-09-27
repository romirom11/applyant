// Every role output schema, by name. schemas.strict.test.ts checks each one converts to the
// strict JSON Schema subset both SDKs accept (Codex strict mode is the narrower one).
import type { z } from 'zod';
import { decisionSchema } from '../decide.ts';
import { answerCheckSchema, writerSchema } from './application.ts';
import { claimCheckSchema } from './claim-check.ts';
import { sourceExtractionSchema } from './extractor.ts';
import { matcherSchema, postingExtractionSchema } from './posting.ts';

export const ROLE_SCHEMAS: Record<string, z.ZodType> = {
  source_extraction: sourceExtractionSchema,
  claim_check: claimCheckSchema,
  application_writer: writerSchema,
  answer_check: answerCheckSchema,
  posting_extraction: postingExtractionSchema,
  matcher: matcherSchema,
  // Fallback for the Jev decision roles (field_classify, option_match, posting_liveness).
  decision: decisionSchema,
};

export * from './application.ts';
export { CLAIM_ISSUES, type ClaimCheck, claimCheckSchema } from './claim-check.ts';
export { type SourceExtraction, sourceExtractionSchema } from './extractor.ts';
export * from './posting.ts';
