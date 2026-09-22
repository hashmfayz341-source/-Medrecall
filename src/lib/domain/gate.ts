import { ConceptNotActiveError } from "./errors";
import type { Concept } from "./types";

/**
 * The Concept Approval Gate.
 *
 * DRAFT concepts are candidates only. They must be reviewed and approved by a
 * human before they can influence learning in any way.
 *
 * This gate lives in the domain layer on purpose. Enforcing it only in the UI
 * would mean any new caller (an API route, a background job, a future mobile
 * client) could quietly bypass it.
 */

/** The learning stages the gate protects. */
export type GatedStage =
  | "teaching"
  | "retrieval"
  | "mastery"
  | "scheduling"
  | "interleaving"
  | "today";

export function isActive(concept: Concept): boolean {
  return concept.status === "ACTIVE";
}

/** Throws unless the concept is ACTIVE. Use at every entry point to a stage. */
export function assertActive(concept: Concept, stage: GatedStage): void {
  if (!isActive(concept)) {
    throw new ConceptNotActiveError(concept.id, concept.status, stage);
  }
}

/** Filters a list down to the concepts allowed into the learning system. */
export function activeOnly(concepts: readonly Concept[]): Concept[] {
  return concepts.filter(isActive);
}

/** Throws if ANY concept in the list is not ACTIVE. */
export function assertAllActive(
  concepts: readonly Concept[],
  stage: GatedStage,
): void {
  for (const concept of concepts) {
    assertActive(concept, stage);
  }
}
