import type {
  ConceptProgress,
  MasteryState,
  RetrievalContext,
  ScheduleState,
} from "./types";

/**
 * Mastery transitions.
 *
 * The central rule of MedRecall:
 *
 *   A wrong answer marks a Concept WEAK, and answering correctly straight
 *   after reading the explanation does NOT clear that weakness.
 *
 * Recognition immediately after being told the answer is not retrieval. Only a
 * later SPACED or INTERLEAVED success — separated from the explanation by time
 * and other material — is evidence the learner actually holds the concept.
 */

export interface RetrievalOutcome {
  correct: boolean;
  context: RetrievalContext;
  /** ISO timestamp of the attempt. */
  at: string;
}

/** Contexts where a success counts as genuine, unaided retrieval. */
export function countsAsSpacedSuccess(context: RetrievalContext): boolean {
  return context === "SPACED" || context === "INTERLEAVED";
}

/**
 * Mastery ladder, driven by consecutive spaced successes since the last
 * failure. A failure resets the counter to 0, so a previously WEAK concept
 * must climb again from LEARNING.
 */
export function masteryForStreak(streak: number): MasteryState {
  if (streak >= 3) return "STRONG";
  if (streak === 2) return "STABLE";
  if (streak === 1) return "LEARNING";
  return "NEW";
}

export function createProgress(
  conceptId: string,
  schedule: ScheduleState,
): ConceptProgress {
  return {
    conceptId,
    mastery: "NEW",
    consecutiveSpacedSuccesses: 0,
    totalAttempts: 0,
    totalCorrect: 0,
    everWrong: false,
    immediateRemediationPassed: false,
    lastAttemptAt: null,
    schedule,
  };
}

/**
 * Pure mastery transition. Returns a new ConceptProgress; `schedule` is passed
 * through untouched (the scheduler owns it).
 */
export function applyRetrievalToMastery(
  progress: ConceptProgress,
  outcome: RetrievalOutcome,
): ConceptProgress {
  const base: ConceptProgress = {
    ...progress,
    totalAttempts: progress.totalAttempts + 1,
    totalCorrect: progress.totalCorrect + (outcome.correct ? 1 : 0),
    lastAttemptAt: outcome.at,
  };

  // A wrong answer always marks the concept WEAK and resets the streak.
  if (!outcome.correct) {
    return {
      ...base,
      mastery: "WEAK",
      consecutiveSpacedSuccesses: 0,
      everWrong: true,
      immediateRemediationPassed: false,
    };
  }

  // Correct, but immediately after seeing the explanation. We record that the
  // learner followed the remediation, and deliberately leave mastery alone.
  if (outcome.context === "IMMEDIATE_REMEDIATION") {
    return { ...base, immediateRemediationPassed: true };
  }

  // Correct during a spaced or interleaved check: real evidence of retrieval.
  if (countsAsSpacedSuccess(outcome.context)) {
    const streak = progress.consecutiveSpacedSuccesses + 1;
    return {
      ...base,
      consecutiveSpacedSuccesses: streak,
      mastery: masteryForStreak(streak),
    };
  }

  // Correct on the first pass through new material. Worth something, but it is
  // not spaced retrieval, so it cannot rescue a WEAK concept.
  if (progress.mastery === "NEW") {
    return { ...base, mastery: "LEARNING" };
  }

  return base;
}

export function isWeak(progress: ConceptProgress): boolean {
  return progress.mastery === "WEAK";
}

/** Mastery states that still need work before a lecture counts as finished. */
export function needsMoreWork(progress: ConceptProgress): boolean {
  return progress.mastery === "NEW" || progress.mastery === "WEAK";
}
