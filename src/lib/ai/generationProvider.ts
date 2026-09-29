import { DeterministicProvider } from "./deterministic";
import { assertProviderPermitted } from "./policy";
import type { CardGenerationProvider } from "./provider";

/**
 * The CARD GENERATION provider resolver. Used by POST /api/generate and
 * nothing else — the third role, resolved separately from grading and
 * extraction for the same reason those two are (AD-23): binding a hosted
 * card generator must not change grading or PDF extraction.
 *
 * Always deterministic today. A hosted generator (one that can translate
 * explanations, write better questions, or read the page images) plugs in
 * here, behind the same `assertProviderPermitted()` gate: it is refused
 * until server-side abuse control exists (AD-22).
 */
export function getGenerationProvider(): CardGenerationProvider {
  return assertProviderPermitted(new DeterministicProvider());
}
