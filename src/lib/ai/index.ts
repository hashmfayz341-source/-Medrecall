import { DeterministicProvider } from "./deterministic";
import type { AiProvider } from "./provider";

export type { AiProvider } from "./provider";
export { DeterministicProvider } from "./deterministic";

/**
 * Provider resolution.
 *
 * Always the deterministic provider for now. When a hosted provider is added,
 * resolve it here from a SERVER-SIDE env var only — this module must never be
 * imported into a client component, and no key may be exposed through
 * NEXT_PUBLIC_*.
 *
 * Callers: POST /api/grade (grading + remediation) and POST /api/ingest
 * (extraction). Adding a real model is a change here plus an adapter that
 * implements AiProvider — the tutor engine and the UI do not change.
 */
export function getProvider(): AiProvider {
  return new DeterministicProvider();
}
