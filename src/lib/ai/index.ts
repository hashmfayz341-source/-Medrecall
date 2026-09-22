import { DeterministicProvider } from "./deterministic";
import type { AiProvider } from "./provider";

export type { AiProvider } from "./provider";
export { DeterministicProvider } from "./deterministic";

/**
 * Provider resolution.
 *
 * Milestone 1 always returns the deterministic provider. When a hosted
 * provider is added, resolve it here from a SERVER-SIDE env var only — this
 * module must never be imported into a client component, and no key may be
 * exposed through NEXT_PUBLIC_*.
 */
export function getProvider(): AiProvider {
  return new DeterministicProvider();
}
