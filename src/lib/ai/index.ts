import { DeterministicProvider } from "./deterministic";
import { assertProviderPermitted } from "./policy";
import type { AiProvider } from "./provider";

export type { AiProvider, GradeFreeAnswerInput } from "./provider";
export { DeterministicProvider } from "./deterministic";
export {
  HOSTED_PROVIDER_SAFEGUARDS,
  ProviderNotPermittedError,
  assertProviderPermitted,
} from "./policy";

/**
 * Provider resolution.
 *
 * Always the deterministic provider for now. When a hosted provider is added,
 * resolve it here from a SERVER-SIDE env var only — this module must never be
 * imported into a client component, and no key may be exposed through
 * NEXT_PUBLIC_*.
 *
 * Callers: POST /api/grade (the grading decision) and POST /api/ingest
 * (extraction). Adding a real model is an adapter implementing AiProvider plus
 * a binding here — the tutor engine, the route contracts and the UI do not
 * change. But a hosted provider is refused by `assertProviderPermitted()`
 * until the server-side abuse controls in ./policy.ts exist, so it cannot be
 * switched on by an env var alone.
 */
export function getProvider(): AiProvider {
  return assertProviderPermitted(new DeterministicProvider());
}
