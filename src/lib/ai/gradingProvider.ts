import { DeterministicProvider } from "./deterministic";
import { assertProviderPermitted } from "./policy";
import type { GradingProvider } from "./provider";

/**
 * The GRADING provider resolver. Used by POST /api/grade and nothing else.
 *
 * Deliberately separate from `getExtractionProvider()`: Stage B's hosted model
 * grader is bound HERE, and binding it must not change PDF concept extraction,
 * make uploads call a paid model, or require the grader to implement
 * extraction. Any future configuration for the grader is read in this module
 * only, server-side (never NEXT_PUBLIC_*).
 *
 * Always deterministic for now. A hosted grader is refused by
 * `assertProviderPermitted()` until server-side abuse control exists (AD-22).
 */
export function getGradingProvider(): GradingProvider {
  return assertProviderPermitted(new DeterministicProvider());
}
