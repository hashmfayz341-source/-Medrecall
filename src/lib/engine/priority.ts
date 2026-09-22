import { activeOnly } from "@/lib/domain/gate";
import { isDue } from "./scheduler";
import type {
  Concept,
  ConceptProgress,
  Curriculum,
  LearnerState,
} from "@/lib/domain/types";

/**
 * What to review next.
 *
 * Priority order from the product spec:
 *   1. due concepts
 *   2. previously wrong / weak concepts
 *   3. important core concepts
 *   4. prerequisites relevant to the current material
 *
 * Implemented as additive weights rather than a strict sort chain so a badly
 * overdue CORE concept can outrank a barely-due SUPPORTING one.
 */

export const WEIGHTS = {
  weak: 1000,
  everWrong: 300,
  due: 500,
  overduePerDay: 25,
  overdueCap: 250,
  core: 100,
  prerequisite: 200,
} as const;

export interface ScoreContext {
  now: Date;
  /** Concept ids the learner is working on right now. */
  currentConceptIds?: readonly string[];
  curriculum: Curriculum;
}

function prerequisiteIdsFor(
  curriculum: Curriculum,
  conceptIds: readonly string[],
): Set<string> {
  const byId = new Map(curriculum.concepts.map((c) => [c.id, c]));
  const out = new Set<string>();
  for (const id of conceptIds) {
    const concept = byId.get(id);
    if (!concept) continue;
    for (const prereq of concept.prerequisiteIds) out.add(prereq);
  }
  return out;
}

export function scoreConcept(
  concept: Concept,
  progress: ConceptProgress | undefined,
  ctx: ScoreContext,
  prerequisites?: Set<string>,
): number {
  if (!progress) return 0;

  let score = 0;

  if (progress.mastery === "WEAK") score += WEIGHTS.weak;
  if (progress.everWrong) score += WEIGHTS.everWrong;

  if (isDue(progress, ctx.now)) {
    score += WEIGHTS.due;
    const overdueMs = ctx.now.getTime() - new Date(progress.schedule.due).getTime();
    const overdueDays = Math.max(0, Math.floor(overdueMs / 86_400_000));
    score += Math.min(overdueDays * WEIGHTS.overduePerDay, WEIGHTS.overdueCap);
  }

  if (concept.importance === "CORE") score += WEIGHTS.core;

  const prereqs =
    prerequisites ??
    prerequisiteIdsFor(ctx.curriculum, ctx.currentConceptIds ?? []);
  if (prereqs.has(concept.id)) score += WEIGHTS.prerequisite;

  return score;
}

export interface QueueEntry {
  concept: Concept;
  progress: ConceptProgress;
  score: number;
}

/**
 * The Today queue: every ACTIVE concept that is due or weak, most urgent
 * first. DRAFT concepts are filtered out by `activeOnly` before scoring, so a
 * draft can never surface here.
 */
export function buildTodayQueue(
  curriculum: Curriculum,
  learner: LearnerState,
  now: Date,
  currentConceptIds: readonly string[] = [],
): QueueEntry[] {
  const ctx: ScoreContext = { now, curriculum, currentConceptIds };
  const prerequisites = prerequisiteIdsFor(curriculum, currentConceptIds);

  return activeOnly(curriculum.concepts)
    .map((concept) => {
      const progress = learner.progress[concept.id];
      return { concept, progress };
    })
    .filter(
      (entry): entry is { concept: Concept; progress: ConceptProgress } =>
        entry.progress !== undefined &&
        entry.progress.totalAttempts > 0 &&
        (entry.progress.mastery === "WEAK" || isDue(entry.progress, now)),
    )
    .map(({ concept, progress }) => ({
      concept,
      progress,
      score: scoreConcept(concept, progress, ctx, prerequisites),
    }))
    .sort((a, b) => b.score - a.score || a.concept.id.localeCompare(b.concept.id));
}

/** Every ACTIVE concept currently marked WEAK. */
export function weakConcepts(
  curriculum: Curriculum,
  learner: LearnerState,
): QueueEntry[] {
  const now = new Date();
  return activeOnly(curriculum.concepts)
    .map((concept) => ({ concept, progress: learner.progress[concept.id] }))
    .filter(
      (e): e is { concept: Concept; progress: ConceptProgress } =>
        e.progress !== undefined && e.progress.mastery === "WEAK",
    )
    .map(({ concept, progress }) => ({
      concept,
      progress,
      score: scoreConcept(concept, progress, { now, curriculum }),
    }))
    .sort((a, b) => b.score - a.score || a.concept.id.localeCompare(b.concept.id));
}
