import { DeterministicProvider } from "./deterministic";
import { assertProviderPermitted } from "./policy";
import type { ExtractionProvider } from "./provider";

/**
 * The EXTRACTION provider resolver. Used by POST /api/ingest and nothing else.
 *
 * Deliberately separate from `getGradingProvider()`: changing the grader
 * (Stage B) must leave Milestone 2's deterministic PDF extraction untouched.
 * Changing extraction is its own, separately reviewed decision, read in this
 * module only.
 *
 * Always deterministic. A hosted extractor would be refused by
 * `assertProviderPermitted()` until server-side abuse control exists (AD-22).
 */
export function getExtractionProvider(): ExtractionProvider {
  return assertProviderPermitted(new DeterministicProvider());
}
