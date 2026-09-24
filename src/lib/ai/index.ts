export type {
  AiProvider,
  ExtractionProvider,
  GradeFreeAnswerInput,
  GradingProvider,
  ProviderIdentity,
} from "./provider";
export { DeterministicProvider } from "./deterministic";
export {
  HOSTED_PROVIDER_SAFEGUARDS,
  ProviderNotPermittedError,
  assertProviderPermitted,
} from "./policy";

/*
 * Provider resolution is split by ROLE, one resolver per route:
 *
 *   getGradingProvider()    — ./gradingProvider.ts    — POST /api/grade only
 *   getExtractionProvider() — ./extractionProvider.ts — POST /api/ingest only
 *
 * There is intentionally no single `getProvider()`: one resolver for both
 * roles would let binding a hosted grader silently change PDF extraction.
 * Routes import their resolver module directly, not this barrel.
 *
 * Server-only: nothing under lib/ai may be imported into a client component.
 */
export { getGradingProvider } from "./gradingProvider";
export { getExtractionProvider } from "./extractionProvider";
