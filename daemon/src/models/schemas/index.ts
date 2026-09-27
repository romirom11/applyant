// Every role output schema, by name. schemas.strict.test.ts checks each one converts to the
// strict JSON Schema subset both SDKs accept (Codex strict mode is the narrower one).
import type { z } from 'zod';
import { claimCheckSchema } from './claim-check.ts';
import { sourceExtractionSchema } from './extractor.ts';

export const ROLE_SCHEMAS: Record<string, z.ZodType> = {
  source_extraction: sourceExtractionSchema,
  claim_check: claimCheckSchema,
};

export { CLAIM_ISSUES, type ClaimCheck, claimCheckSchema } from './claim-check.ts';
export { type SourceExtraction, sourceExtractionSchema } from './extractor.ts';
