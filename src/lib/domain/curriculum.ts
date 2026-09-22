import type { Concept, ConceptStatus, Curriculum } from "./types";

/**
 * Shared curriculum state.
 *
 * Concept status is curriculum-level, not learner-level: approving a concept
 * changes the course for everyone studying it, while mastery is personal. They
 * are stored separately so curriculum can move to a server later without
 * touching per-learner records.
 */
export interface CurriculumOverrides {
  version: number;
  statusById: Record<string, ConceptStatus>;
}

export const CURRICULUM_OVERRIDES_VERSION = 1;

export function createOverrides(): CurriculumOverrides {
  return { version: CURRICULUM_OVERRIDES_VERSION, statusById: {} };
}

export function applyOverrides(
  curriculum: Curriculum,
  overrides: CurriculumOverrides | null,
): Curriculum {
  if (!overrides || Object.keys(overrides.statusById).length === 0) {
    return curriculum;
  }
  const concepts: Concept[] = curriculum.concepts.map((concept) => {
    const status = overrides.statusById[concept.id];
    return status ? { ...concept, status } : concept;
  });
  return { ...curriculum, concepts };
}

export function setConceptStatus(
  overrides: CurriculumOverrides,
  conceptId: string,
  status: ConceptStatus,
): CurriculumOverrides {
  return {
    ...overrides,
    statusById: { ...overrides.statusById, [conceptId]: status },
  };
}

export function draftConcepts(curriculum: Curriculum): Concept[] {
  return curriculum.concepts.filter((c) => c.status === "DRAFT");
}
